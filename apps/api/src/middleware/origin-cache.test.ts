import { describe, expect, it } from 'vitest';
import { cachedOriginCheck } from './origin-cache';

function counting(answers: Record<string, boolean>) {
  const calls: string[] = [];
  const check = async (origin: string) => {
    calls.push(origin);
    if (!(origin in answers)) throw new Error('db down');
    return answers[origin]!;
  };
  return { calls, check };
}

describe('cachedOriginCheck', () => {
  it('answers a repeated origin from memory until the TTL passes', async () => {
    let clock = 0;
    const { calls, check } = counting({ 'https://a.test': true, 'https://evil.test': false });
    const cached = cachedOriginCheck(check, { ttlMs: 30_000, now: () => clock });

    expect(await cached('https://a.test')).toBe(true);
    expect(await cached('https://a.test')).toBe(true);
    expect(await cached('https://evil.test')).toBe(false);
    expect(await cached('https://evil.test')).toBe(false);
    expect(calls).toEqual(['https://a.test', 'https://evil.test']);

    clock = 30_000;
    expect(await cached('https://a.test')).toBe(true);
    expect(calls).toEqual(['https://a.test', 'https://evil.test', 'https://a.test']);
  });

  it('does not cache a failed lookup', async () => {
    const { calls, check } = counting({});
    const cached = cachedOriginCheck(check, { now: () => 0 });

    await expect(cached('https://x.test')).rejects.toThrow('db down');
    await expect(cached('https://x.test')).rejects.toThrow('db down');
    expect(calls).toHaveLength(2);
  });

  it('keeps at most maxEntries origins, dropping the oldest', async () => {
    const { calls, check } = counting({
      'https://1.test': false,
      'https://2.test': false,
      'https://3.test': false,
    });
    const cached = cachedOriginCheck(check, { maxEntries: 2, now: () => 0 });

    for (const n of [1, 2, 3, 1]) await cached(`https://${n}.test`);

    expect(calls).toEqual(['https://1.test', 'https://2.test', 'https://3.test', 'https://1.test']);
  });
});
