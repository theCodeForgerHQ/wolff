// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

/** An Upstash-like store whose every call yields, as a network round trip does. */
const store = vi.hoisted(() => {
  const data = new Map<string, unknown>();
  const tick = () => new Promise((r) => setTimeout(r, 1));
  return {
    data,
    redis: {
      // A copy, as a real store returns: never the stored object itself.
      get: async (k: string) => (await tick(), structuredClone(data.get(k) ?? null)),
      set: async (k: string, v: unknown) => (await tick(), data.set(k, structuredClone(v)), 'OK'),
      del: async (k: string) => (await tick(), data.delete(k), 1),
      incr: async (k: string) => {
        await tick();
        const n = Number(data.get(k) ?? 0) + 1;
        data.set(k, n);
        return n;
      },
      expire: async () => (await tick(), 1),
    },
  };
});
vi.mock('@/lib/redis', () => ({ getRedis: () => store.redis }));

import { generateSigningOtp, verifySigningOtp } from '@/lib/signing/otp';

describe('signing OTP attempts', () => {
  // Each verify read the record, added one and wrote it back, so parallel
  // guesses all saw 0 attempts: far more than 5 tries per code.
  it('allows at most 5 guesses per code, even all at once', async () => {
    const code = await generateSigningOtp('k1', 'signer@example.com');
    const wrong = code === '123456' ? '654321' : '123456';
    const results = await Promise.all(
      Array.from({ length: 10 }, () => verifySigningOtp('k1', wrong, 'signer@example.com'))
    );
    const counted = results.filter((r) => r.error?.startsWith('Invalid code'));
    expect(counted.length).toBeLessThanOrEqual(5);
    // The right code no longer works once the guesses are used up.
    expect(await verifySigningOtp('k1', code, 'signer@example.com')).toMatchObject({
      valid: false,
    });
  });

  it('still accepts the right code within the limit', async () => {
    const code = await generateSigningOtp('k2', 'signer@example.com');
    const wrong = code === '123456' ? '654321' : '123456';
    await verifySigningOtp('k2', wrong, 'signer@example.com');
    expect(await verifySigningOtp('k2', code, 'signer@example.com')).toEqual({ valid: true });
  });
});
