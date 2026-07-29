import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Redis } from 'ioredis';
import { SignJWT, decodeProtectedHeader, jwtVerify } from 'jose';
import '../context';
import { sendError } from '../http';

/**
 * Service-to-service authentication: HS256 JWTs that live 60
 * seconds. Each calling service has its own secret and names itself in the
 * `kid` header, so one service's secret can be rotated, or revoked, without
 * touching the others, and cannot be used to speak as another service.
 */
export type ServiceIssuer = 'web' | 'ai' | 'worker' | 'lambda';

export const SERVICE_TOKEN_TTL_SECONDS = 60;
/** How long a jti is remembered; longer than a token can live. */
const REPLAY_TTL_SECONDS = 120;

export interface ReplayCache {
  /** Records the id. False when it was already recorded. */
  claim(jti: string, ttlSeconds: number): Promise<boolean>;
}

/** Per-process cache. Enough for one instance and for tests. */
export class MemoryReplayCache implements ReplayCache {
  private readonly seen = new Map<string, number>();

  async claim(jti: string, ttlSeconds: number): Promise<boolean> {
    const now = Date.now();
    for (const [key, expires] of this.seen) if (expires <= now) this.seen.delete(key);
    if (this.seen.has(jti)) return false;
    this.seen.set(jti, now + ttlSeconds * 1000);
    return true;
  }
}

/** Shared cache, so a token replayed against another instance is refused too. */
export class RedisReplayCache implements ReplayCache {
  constructor(private readonly redis: Redis) {}

  async claim(jti: string, ttlSeconds: number): Promise<boolean> {
    return (await this.redis.set(`jti:${jti}`, '1', 'EX', ttlSeconds, 'NX')) === 'OK';
  }
}

export interface ServiceJwtOptions {
  /** Secret per issuer. An issuer without one cannot authenticate. */
  secrets: Partial<Record<ServiceIssuer, string>>;
  /** Issuers this set of routes accepts. */
  issuers: ServiceIssuer[];
  audience: string;
  replayCache: ReplayCache;
}

const BEARER = /^Bearer (\S+)$/;
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/**
 * Accepts only a service JWT. API keys, and any token that fails a single
 * check, get the same 401.
 */
export function requireServiceJwt(options: ServiceJwtOptions): RequestHandler {
  const reject = (res: Parameters<RequestHandler>[1]) =>
    sendError(res, 'unauthorized', 'A valid service token is required');

  return async (req, res, next) => {
    const token = BEARER.exec(req.get('authorization') ?? '')?.[1];
    if (!token) return reject(res);

    try {
      // The key id only selects which secret to try; the signature decides.
      const { kid } = decodeProtectedHeader(token);
      const issuer = options.issuers.find((candidate) => candidate === kid);
      const secret = issuer ? options.secrets[issuer] : undefined;
      if (!issuer || !secret) return reject(res);

      const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
        algorithms: ['HS256'],
        issuer,
        audience: options.audience,
        requiredClaims: ['exp', 'iat', 'jti'],
        maxTokenAge: SERVICE_TOKEN_TTL_SECONDS,
      });

      const { jti, exp, iat, workspaceId, scopes, sub } = payload;
      if (
        typeof jti !== 'string' ||
        typeof exp !== 'number' ||
        typeof iat !== 'number' ||
        exp - iat > SERVICE_TOKEN_TTL_SECONDS ||
        typeof workspaceId !== 'string' ||
        workspaceId.length === 0 ||
        !isStringArray(scopes)
      ) {
        return reject(res);
      }
      if (!(await options.replayCache.claim(jti, REPLAY_TTL_SECONDS))) return reject(res);

      req.ctx = {
        workspaceId,
        keyId: issuer,
        scopes,
        actor: 'service',
        rateLimitPerMin: Number.MAX_SAFE_INTEGER,
        userId: typeof sub === 'string' ? sub : undefined,
      };
      next();
    } catch {
      reject(res);
    }
  };
}

/** Mints a token the way a calling service does. */
export async function mintServiceJwt(input: {
  issuer: ServiceIssuer;
  secret: string;
  audience: string;
  workspaceId: string;
  scopes: string[];
  subject?: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({ workspaceId: input.workspaceId, scopes: input.scopes })
    .setProtectedHeader({ alg: 'HS256', kid: input.issuer })
    .setIssuer(input.issuer)
    .setAudience(input.audience)
    .setIssuedAt(now)
    .setExpirationTime(now + SERVICE_TOKEN_TTL_SECONDS)
    .setJti(randomUUID());
  if (input.subject) jwt.setSubject(input.subject);
  return jwt.sign(new TextEncoder().encode(input.secret));
}
