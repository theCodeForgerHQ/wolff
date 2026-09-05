// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  send: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock('@wolff/database', () => ({
  prisma: {
    user: { findUnique: mocks.findUnique },
    emailVerificationToken: { deleteMany: vi.fn(), create: vi.fn() },
  },
}));
vi.mock('@/lib/services/email', () => ({ sendVerificationEmail: mocks.send }));
vi.mock('@/lib/csrf', () => ({ validateRequestOrigin: () => true }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mocks.rateLimit,
  getRateLimitHeaders: () => ({}),
}));

import { POST } from '@/app/api/auth/resend-verification/route';

const post = (body: unknown) =>
  POST(
    new Request('http://localhost:3000/api/auth/resend-verification', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
      body: JSON.stringify(body),
    })
  );

describe('POST /api/auth/resend-verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rateLimit.mockResolvedValue({ limited: false });
    mocks.findUnique.mockResolvedValue({
      id: 'u-1',
      email: 'new@example.com',
      name: 'New',
      emailVerifiedAt: null,
    });
  });

  it('sends the email and says so', async () => {
    mocks.send.mockResolvedValue({ success: true });
    const res = await post({ email: 'new@example.com' });
    expect(res.status).toBe(200);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'new@example.com' }));
  });

  // sendVerificationEmail reports failure in its result; it does not throw.
  it('does not claim success when the email was not sent', async () => {
    mocks.send.mockResolvedValue({ success: false, error: 'provider down' });
    const res = await post({ email: 'new@example.com' });
    expect(res.status).toBe(500);
  });

  // The route is unauthenticated: its answer must not tell whether an
  // account exists, or whether it is verified.
  it('answers an unknown address exactly like a real one, and sends nothing', async () => {
    mocks.send.mockResolvedValue({ success: true });
    const known = await post({ email: 'new@example.com' });

    mocks.findUnique.mockResolvedValue(null);
    const unknown = await post({ email: 'nobody@example.com' });

    mocks.findUnique.mockResolvedValue({
      id: 'u-2',
      email: 'v@example.com',
      emailVerifiedAt: new Date(),
    });
    const verified = await post({ email: 'v@example.com' });

    const knownBody = await known.json();
    for (const res of [unknown, verified]) {
      expect(res.status).toBe(known.status);
      expect(await res.json()).toEqual(knownBody);
    }
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it('rate limits by IP as well as by address', async () => {
    await post({ email: 'new@example.com' });
    const keys = mocks.rateLimit.mock.calls.map((c) => c[0]);
    expect(keys).toEqual(
      expect.arrayContaining([
        expect.stringContaining('203.0.113.7'),
        expect.stringContaining('new@example.com'),
      ])
    );
  });
});
