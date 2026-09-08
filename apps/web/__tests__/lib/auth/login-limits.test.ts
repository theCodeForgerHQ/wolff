// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Login was limited per email only (5 per 15 minutes), so anyone could lock
 * a person out by failing to sign in as them five times, and one client
 * could try one password against any number of addresses.
 */
const counts = vi.hoisted(() => new Map<string, number>());
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async (key: string, { limit }: { limit: number }) => {
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return { limited: n > limit };
  }),
}));
vi.mock('@wolff/database', () => ({
  prisma: { user: { findUnique: vi.fn().mockResolvedValue(null) } },
}));

import { verifyCredentials } from '@/lib/auth/credentials';

const attempt = (email: string, ip: string) =>
  verifyCredentials(email, 'wrong-password', ip).then(
    () => 'ok',
    (error: Error) => error.message
  );

describe('login rate limits', () => {
  beforeEach(() => counts.clear());

  it('does not lock the owner out when someone else fails as them', async () => {
    for (let i = 0; i < 6; i++) await attempt('victim@example.com', '203.0.113.66');
    expect(await attempt('victim@example.com', '203.0.113.66')).toMatch(/too many/i);
    // The owner, from their own address, is not limited by those failures.
    expect(await attempt('victim@example.com', '198.51.100.7')).not.toMatch(/too many/i);
  });

  it('limits one address trying many accounts', async () => {
    let last = '';
    for (let i = 0; i < 31; i++) last = await attempt(`user${i}@example.com`, '203.0.113.66');
    expect(last).toMatch(/too many/i);
  });
});
