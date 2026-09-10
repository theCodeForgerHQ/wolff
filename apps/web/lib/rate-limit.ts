/**
 * Distributed rate limiter using Upstash Redis.
 * Falls back to in-memory when Redis is not configured (local dev), and
 * per instance while Redis is failing or slow.
 */
import { logger } from '@/lib/logger';

import { Ratelimit } from '@upstash/ratelimit';
import { getRedis } from './redis';

export interface RateLimitOptions {
  /** Maximum requests allowed in the window */
  limit: number;
  /** Window duration in milliseconds */
  windowMs: number;
}

export interface RateLimitResult {
  /** Whether the request is rate limited */
  limited: boolean;
  /** Maximum requests allowed */
  limit: number;
  /** Remaining requests in the window */
  remaining: number;
  /** Unix timestamp when the window resets */
  reset: number;
}

// Cache Upstash Ratelimit instances by config key
const rateLimiters = new Map<string, Ratelimit>();

function getUpstashRateLimiter(options: RateLimitOptions): Ratelimit | null {
  const redis = getRedis();
  if (!redis) return null;

  const configKey = `${options.limit}:${options.windowMs}`;
  let limiter = rateLimiters.get(configKey);
  if (!limiter) {
    const windowSec = Math.ceil(options.windowMs / 1000);
    limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(options.limit, `${windowSec} s`),
      prefix: 'rl',
    });
    rateLimiters.set(configKey, limiter);
  }
  return limiter;
}

// ─── In-memory fallback (for local dev without Redis) ───────────────

interface InMemoryRecord {
  count: number;
  resetAt: number;
}

const inMemoryStore = new Map<string, InMemoryRecord>();
let lastCleanup = Date.now();

function inMemoryCleanup() {
  const now = Date.now();
  if (now - lastCleanup < 60000) return;
  lastCleanup = now;
  for (const [key, record] of inMemoryStore.entries()) {
    if (now > record.resetAt) inMemoryStore.delete(key);
  }
}

function checkInMemory(key: string, options: RateLimitOptions): RateLimitResult {
  inMemoryCleanup();
  const now = Date.now();
  const record = inMemoryStore.get(key);

  if (!record || now > record.resetAt) {
    const resetAt = now + options.windowMs;
    inMemoryStore.set(key, { count: 1, resetAt });
    return {
      limited: false,
      limit: options.limit,
      remaining: options.limit - 1,
      reset: Math.floor(resetAt / 1000),
    };
  }

  record.count++;
  if (record.count > options.limit) {
    return {
      limited: true,
      limit: options.limit,
      remaining: 0,
      reset: Math.floor(record.resetAt / 1000),
    };
  }

  return {
    limited: false,
    limit: options.limit,
    remaining: options.limit - record.count,
    reset: Math.floor(record.resetAt / 1000),
  };
}

// ─── Main export ────────────────────────────────────────────────────

/**
 * Check rate limit for a given key.
 * Uses Upstash Redis when available, falls back to in-memory for local dev.
 * All callers must await this function.
 */
export async function checkRateLimit(
  key: string,
  options: RateLimitOptions
): Promise<RateLimitResult> {
  try {
    const upstash = getUpstashRateLimiter(options);

    if (!upstash) {
      return checkInMemory(key, options);
    }

    const result = await withTimeout(upstash.limit(key), REDIS_TIMEOUT_MS);
    return {
      limited: !result.success,
      limit: result.limit,
      remaining: result.remaining,
      reset: result.reset,
    };
  } catch (err) {
    // An outage would otherwise log (and report) once per request.
    const now = Date.now();
    if (now - lastOutageLog >= OUTAGE_LOG_INTERVAL_MS) {
      lastOutageLog = now;
      logger.error({ err }, '[rate-limit] Redis error, falling back to in-memory');
    }
    // Each instance keeps limiting on its own until Redis is back.
    return checkInMemory(key, options);
  }
}

/** A slow Redis must not hold up every login and API call behind it. */
const REDIS_TIMEOUT_MS = 1_000;
const OUTAGE_LOG_INTERVAL_MS = 60_000;
let lastOutageLog = -Infinity;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Redis did not answer in ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Get rate limit headers to add to response
 */
export function getRateLimitHeaders(result: RateLimitResult): HeadersInit {
  return {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(result.reset),
  };
}

/**
 * Default rate limit configuration for API routes
 */
export const defaultRateLimitOptions: RateLimitOptions = {
  limit: 100,
  windowMs: 60000, // 1 minute
};

/**
 * Stricter rate limit for sensitive operations
 */
export const strictRateLimitOptions: RateLimitOptions = {
  limit: 10,
  windowMs: 60000, // 1 minute
};
