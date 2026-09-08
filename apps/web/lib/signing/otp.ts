import { randomInt, timingSafeEqual } from 'crypto';
import { getRedis } from '../redis';

/**
 * OTP verification for signer identity.
 * Uses Upstash Redis for cross-instance persistence on serverless.
 * Falls back to in-memory when Redis is not configured (local dev).
 */

interface OtpRecord {
  code: string;
  email: string;
  expiresAt: number;
  attempts: number;
  verified: boolean;
}

// In-memory fallback for local dev
const inMemoryStore = new Map<string, OtpRecord>();

const OTP_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
const OTP_EXPIRY_SEC = 600; // 10 minutes in seconds for Redis TTL
const MAX_ATTEMPTS = 5;
const REDIS_PREFIX = 'otp:';

// ─── Redis helpers ──────────────────────────────────────────────────

async function redisGet(key: string): Promise<OtpRecord | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const data = await redis.get<OtpRecord>(`${REDIS_PREFIX}${key}`);
    return data;
  } catch {
    return null;
  }
}

async function redisSet(key: string, record: OtpRecord): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    await redis.set(`${REDIS_PREFIX}${key}`, record, { ex: OTP_EXPIRY_SEC });
    return true;
  } catch {
    return false;
  }
}

async function redisDel(key: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(`${REDIS_PREFIX}${key}`);
  } catch {
    // ignore
  }
}

const ATTEMPTS_PREFIX = 'otp:attempts:';

/**
 * Claims one attempt with an atomic INCR on its own key, so parallel guesses
 * cannot all read the same count. Null when Redis is not there to count.
 */
async function claimRedisAttempt(key: string): Promise<number | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const attempt = await redis.incr(`${ATTEMPTS_PREFIX}${key}`);
    if (attempt === 1) await redis.expire(`${ATTEMPTS_PREFIX}${key}`, OTP_EXPIRY_SEC);
    return attempt;
  } catch {
    return null;
  }
}

async function resetRedisAttempts(key: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(`${ATTEMPTS_PREFIX}${key}`);
  } catch {
    // ignore: the counter expires with the code
  }
}

// ─── Main OTP functions ─────────────────────────────────────────────

/**
 * Generate a 6-digit OTP for a signing session.
 * Returns the code to be emailed to the signer.
 */
export async function generateSigningOtp(key: string, email: string): Promise<string> {
  const code = String(randomInt(100000, 999999));

  const record: OtpRecord = {
    code,
    email: email.toLowerCase(),
    expiresAt: Date.now() + OTP_EXPIRY_MS,
    attempts: 0,
    verified: false,
  };

  // Try Redis first, fall back to in-memory
  const stored = await redisSet(key, record);
  if (stored) await resetRedisAttempts(key);
  if (!stored) {
    inMemoryStore.set(key, record);
  }

  return code;
}

/**
 * Verify a signing OTP.
 * Returns { valid, error } — valid=true means identity is verified.
 */
export async function verifySigningOtp(
  key: string,
  code: string,
  email: string
): Promise<{ valid: boolean; error?: string }> {
  // Try Redis first, then in-memory
  let record = await redisGet(key);
  const fromRedis = !!record;
  if (!record) {
    record = inMemoryStore.get(key) || null;
  }

  if (!record) {
    return { valid: false, error: 'No verification code found. Please request a new one.' };
  }

  if (Date.now() > record.expiresAt) {
    if (fromRedis) await redisDel(key);
    else inMemoryStore.delete(key);
    return { valid: false, error: 'Verification code has expired. Please request a new one.' };
  }

  if (record.email !== email.toLowerCase()) {
    return { valid: false, error: 'Email address does not match.' };
  }

  // Claim this attempt before comparing. In memory one process does the
  // counting, so the increment cannot interleave; in Redis it is an INCR.
  let attempt: number;
  if (fromRedis) {
    const claimed = await claimRedisAttempt(key);
    if (claimed === null) {
      return { valid: false, error: 'Could not verify the code right now. Please try again.' };
    }
    attempt = claimed;
  } else {
    attempt = ++record.attempts;
  }
  if (attempt > MAX_ATTEMPTS) {
    if (fromRedis) await redisDel(key);
    else inMemoryStore.delete(key);
    return { valid: false, error: 'Too many failed attempts. Please request a new code.' };
  }

  // Constant-time comparison to prevent timing side-channel attacks
  const codeMatch =
    record.code.length === code.length &&
    timingSafeEqual(Buffer.from(record.code), Buffer.from(code));
  if (!codeMatch) {
    if (!fromRedis) inMemoryStore.set(key, record);
    return {
      valid: false,
      error: `Invalid code. ${MAX_ATTEMPTS - attempt} attempts remaining.`,
    };
  }

  // Mark as verified
  record.verified = true;
  if (fromRedis) await redisSet(key, record);
  else inMemoryStore.set(key, record);

  return { valid: true };
}

/**
 * Check if a signing session has been verified via OTP.
 */
export async function isSigningVerified(key: string): Promise<boolean> {
  let record = await redisGet(key);
  if (!record) {
    record = inMemoryStore.get(key) || null;
  }
  if (!record) return false;
  if (Date.now() > record.expiresAt) {
    return false;
  }
  return record.verified;
}
