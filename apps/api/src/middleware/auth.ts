import type { Request, RequestHandler } from 'express';
import { rateLimit, type Store } from 'express-rate-limit';
import type { Redis } from 'ioredis';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { authenticateApiKey, PUBLISHABLE_KEY_PREFIX } from '@wolff/core/auth/api-keys';
import type { Db } from '@wolff/core/context';
import '../context';
import { sendError } from '../http';

const BEARER = /^Bearer (\S+)$/;

function bearerToken(req: Request): string | null {
  return BEARER.exec(req.get('authorization') ?? '')?.[1] ?? null;
}

function publishableToken(req: Request): string | null {
  const header = req.get('x-publishable-key');
  if (header) return header;
  const auth = bearerToken(req);
  if (auth?.startsWith(PUBLISHABLE_KEY_PREFIX)) return auth;
  return null;
}

/**
 * A browser always sends `Origin` on a cross-origin request and a page cannot
 * set it, so it is the only thing checked; `Referer` is not a substitute.
 * The match is exact (scheme, host and port). A key with no allowed origins
 * is usable from nowhere, not from everywhere.
 */
function originAllowed(allowed: readonly string[], origin: string | undefined): boolean {
  if (!origin || allowed.length === 0) return false;
  return allowed.includes(origin);
}

/**
 * Authenticates a secret API key from `Authorization: Bearer <key>` and sets
 * `req.ctx`. Every failure gets the same 401; which check failed is not
 * revealed. Publishable keys are for the public routes and are refused here.
 */
export function requireApiKey(db: Db): RequestHandler {
  return async (req, res, next) => {
    const token = bearerToken(req);
    const result = token ? await authenticateApiKey(db, token) : null;

    if (!result?.ok || result.key.kind !== 'secret') {
      res.set('WWW-Authenticate', 'Bearer');
      sendError(
        res,
        'unauthorized',
        result && !result.ok && result.reason === 'expired'
          ? 'API key has expired'
          : 'Missing or invalid API key. Use: Authorization: Bearer <api_key>'
      );
      return;
    }

    req.ctx = {
      workspaceId: result.key.workspaceId,
      keyId: result.key.id,
      scopes: result.key.scopes,
      actor: 'api_key',
      rateLimitPerMin: result.key.rateLimitPerMin,
    };
    next();
  };
}

/** Requires every listed scope on the authenticated key. */
export function requireScopes(...required: string[]): RequestHandler {
  return (req, res, next) => {
    const granted = req.ctx?.scopes ?? [];
    const missing = required.find((scope) => !granted.includes(scope));
    if (missing) {
      sendError(res, 'insufficient_scope', `This API key lacks the scope ${missing}`);
      return;
    }
    next();
  };
}

/**
 * Authenticates a publishable key from `X-Publishable-Key` (or a Bearer token
 * with the publishable prefix). Sets `req.ctx` only when the key is valid,
 * not expired, and the Origin header is exactly one of the key's allowedOrigins.
 */
export function requirePublishableKey(db: Db): RequestHandler {
  return async (req, res, next) => {
    const token = publishableToken(req);
    const result = token ? await authenticateApiKey(db, token) : null;
    const origin = req.get('origin') ?? undefined;

    if (!result?.ok || result.key.kind !== 'publishable') {
      sendError(res, 'unauthorized', 'Missing or invalid publishable key');
      return;
    }

    if (!originAllowed(result.key.allowedOrigins, origin)) {
      // CORS ran first and reflected the origin; take it back so the page
      // that called cannot read even the refusal.
      res.removeHeader('Access-Control-Allow-Origin');
      sendError(res, 'unauthorized', 'Origin not allowed');
      return;
    }

    req.ctx = {
      workspaceId: result.key.workspaceId,
      keyId: result.key.id,
      scopes: result.key.scopes,
      actor: 'publishable_key',
      rateLimitPerMin: result.key.rateLimitPerMin,
    };
    next();
  };
}

/**
 * Per-key rate limit: `ApiKey.rateLimitPerMin` requests per
 * minute, counted per key id. Must run after `requireApiKey`. With a Redis
 * store the count is shared by all instances; without one it is per process.
 */
export function apiKeyRateLimit(store?: Store): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: (req) => (req as Request).ctx?.rateLimitPerMin ?? 120,
    keyGenerator: (req) => (req as Request).ctx?.keyId ?? 'anonymous',
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    store,
    handler: (_req, res) => {
      sendError(res, 'rate_limited', 'Too many requests. Retry after the time in Retry-After.');
    },
  });
}

/**
 * Rate-limit counters in the Redis that also holds the queue, under their own
 * `rl:` prefix.
 */
export function redisRateLimitStore(redis: Redis): Store {
  return new RedisStore({
    prefix: 'rl:key:',
    sendCommand: (command: string, ...args: string[]) =>
      redis.call(command, ...args) as Promise<RedisReply>,
  });
}
