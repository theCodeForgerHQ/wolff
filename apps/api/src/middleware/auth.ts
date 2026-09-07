import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator, MemoryStore, rateLimit, type Store } from 'express-rate-limit';
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
    releaseAuthFailureSlot(req);
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
    releaseAuthFailureSlot(req);
    next();
  };
}

/** Makes a rate-limit store for one limiter (each limiter needs its own). */
export type RateLimitStoreFactory = (prefix: string) => Store;

const BURST_WINDOW_MS = 10_000;
const BURST = 20;

const rateLimited: RequestHandler = (_req, res) => {
  sendError(res, 'rate_limited', 'Too many requests. Retry after the time in Retry-After.');
};

/**
 * Per-key rate limit: `ApiKey.rateLimitPerMin` requests per
 * minute, with bursts of at most 20. The burst is a second window of 10 s
 * allowing 20 requests (or a sixth of the minute's allowance for keys above
 * 120/min), so 120/min cannot be spent in the first second. Counted per key
 * id; must run after the key is authenticated. With a Redis store the counts
 * are shared by all instances; without one they are per process.
 */
export function apiKeyRateLimit(createStore?: RateLimitStoreFactory): RequestHandler {
  const keyOf = (req: Request) => req.ctx?.keyId ?? 'anonymous';
  const perMinute = (req: Request) => req.ctx?.rateLimitPerMin ?? 120;
  const minute = rateLimit({
    windowMs: 60_000,
    limit: (req) => perMinute(req as Request),
    keyGenerator: (req) => keyOf(req as Request),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    store: createStore?.('rl:key:'),
    // A store that errors (Redis down) lets the request through: an outage
    // of the counter must not take the API down with it.
    passOnStoreError: true,
    handler: rateLimited,
  });
  const burst = rateLimit({
    windowMs: BURST_WINDOW_MS,
    limit: (req) => Math.max(BURST, Math.ceil(perMinute(req as Request) / 6)),
    keyGenerator: (req) => keyOf(req as Request),
    standardHeaders: false,
    legacyHeaders: false,
    store: createStore?.('rl:burst:'),
    // A store that errors (Redis down) lets the request through: an outage
    // of the counter must not take the API down with it.
    passOnStoreError: true,
    handler: rateLimited,
  });
  return (req, res, next) => {
    void minute(req, res, (error?: unknown) => {
      if (error) return next(error);
      void burst(req, res, next);
    });
  };
}

const AUTH_FAILURE_WINDOW_MS = 60_000;

/** The pending failed-auth slot of each request, settled at most once. */
const authFailureSlots = new WeakMap<Request, (failed: boolean) => void>();

/** Called by the key checks on success: the request is not a failed attempt. */
function releaseAuthFailureSlot(req: Request): void {
  authFailureSlots.get(req)?.(false);
}
const AUTH_FAILURES = 30;

/**
 * Failed authentication per client IP: 30 failed attempts a
 * minute, then 429 for the rest of the window, so keys cannot be guessed at
 * speed. Mount before the key check.
 *
 * Reserve, then release: each request takes a slot atomically when it
 * arrives, before the key check. requireApiKey and requirePublishableKey
 * give it back the moment the key is accepted; a request that does not
 * reach them gives it back when its response finishes with a status other
 * than 401. A 401 keeps its slot, and so does a request whose connection
 * closes before an answer, so aborted guesses count. A parallel burst of
 * bad keys gets at most 30 tries, since no request can read the count
 * before the others are added to it. The cost: more than 30 requests from
 * one address whose key checks overlap get 429 even if every key is good;
 * a slow endpoint no longer holds the slot after its key check.
 */
export function authFailureRateLimit(
  createStore?: RateLimitStoreFactory,
  { windowMs = AUTH_FAILURE_WINDOW_MS }: { windowMs?: number } = {}
): RequestHandler {
  const store: Store = createStore?.('rl:authfail:') ?? new MemoryStore();
  store.init?.({ windowMs } as never);
  const reserve = async (key: string) => store.increment(key);
  // A slot reserved in a window that has since ended is not given back: the
  // count it was added to is gone, and decrementing would cancel a failure
  // counted in the new window instead.
  const release = async (key: string, resetTime: Date | undefined) => {
    if (resetTime && Date.now() >= resetTime.getTime()) return;
    await store.decrement(key);
  };

  return (req, res, next) => {
    const key = ipKeyGenerator(req.ip ?? 'unknown');
    reserve(key)
      .then(({ totalHits, resetTime }) => {
        let settled = false;
        // Exactly once per request: given back as soon as the key check
        // passes; otherwise kept for a 401 or an abort and given back for
        // any other finished response.
        const settle = (failed: boolean) => {
          if (settled) return;
          settled = true;
          authFailureSlots.delete(req);
          if (!failed) release(key, resetTime).catch(() => {});
        };
        authFailureSlots.set(req, settle);
        res.on('finish', () => settle(res.statusCode === 401));
        // A connection closed before its answer keeps the slot: aborting
        // each guess early must not make it free.
        res.on('close', () => settle(res.writableFinished ? res.statusCode === 401 : true));

        if (totalHits > AUTH_FAILURES) {
          const left = resetTime ? resetTime.getTime() - Date.now() : windowMs;
          res.set('Retry-After', String(Math.max(1, Math.ceil(left / 1000))));
          return rateLimited(req, res, next);
        }
        next();
      })
      .catch(next);
  };
}

/**
 * Rate-limit counters in the Redis that also holds the queue, under their own
 * `rl:` prefix.
 */
export function redisRateLimitStore(redis: Redis, prefix = 'rl:key:'): Store {
  return new GuardedRedisStore(redis, prefix);
}

/**
 * Decrements only a counter that exists and is above 0. RedisStore's plain
 * DECR on a key whose window expired creates it at -1 with no TTL, a key
 * that never expires. DECR on an existing key keeps its TTL.
 */
const GUARDED_DECREMENT = `
local hits = tonumber(redis.call("GET", KEYS[1]))
if hits and hits > 0 then return redis.call("DECR", KEYS[1]) end
return 0
`;

class GuardedRedisStore extends RedisStore {
  constructor(
    private readonly redis: Redis,
    prefix: string
  ) {
    super({
      prefix,
      sendCommand: (command: string, ...args: string[]) =>
        redis.call(command, ...args) as Promise<RedisReply>,
    });
  }

  override async decrement(key: string): Promise<void> {
    await this.redis.eval(GUARDED_DECREMENT, 1, this.prefixKey(key));
  }
}
