// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const limit = vi.hoisted(() => vi.fn());
const logged = vi.hoisted(() => [] as unknown[]);

vi.mock('@/lib/redis', () => ({ getRedis: () => ({}) }));
vi.mock('@upstash/ratelimit', () => {
  class Ratelimit {
    static slidingWindow = () => ({});
    limit = limit;
  }
  return { Ratelimit };
});
vi.mock('@/lib/logger', () => {
  const record = (...args: unknown[]) => void logged.push(args);
  return { logger: { error: record, warn: record, info: () => {}, debug: () => {} } };
});

import { checkRateLimit } from '@/lib/rate-limit';

const options = { limit: 2, windowMs: 60_000 };

describe('checkRateLimit when Redis is failing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    logged.length = 0;
    limit.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('stops waiting on a Redis that hangs and still limits in memory', async () => {
    limit.mockImplementation(() => new Promise(() => {}));

    const pending = checkRateLimit('hang:1', options);
    await vi.advanceTimersByTimeAsync(1_500);
    const first = await pending;

    expect(first.limited).toBe(false);
    const results = [];
    for (let i = 0; i < 2; i++) {
      const p = checkRateLimit('hang:1', options);
      await vi.advanceTimersByTimeAsync(1_500);
      results.push(await p);
    }
    expect(results.map((r) => r.limited)).toEqual([false, true]);
  });

  it('reports the outage once a minute, not on every request', async () => {
    // The throttle is per process: start clear of the other test's report.
    vi.setSystemTime(Date.now() + 10 * 60_000);
    limit.mockRejectedValue(new Error('ECONNRESET'));

    for (let i = 0; i < 50; i++) await checkRateLimit(`flood:${i}`, options);
    expect(logged).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(61_000);
    await checkRateLimit('flood:late', options);
    expect(logged).toHaveLength(2);
  });
});
