// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  send: vi.fn(),
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
  checkRateLimit: vi.fn().mockResolvedValue({ limited: false }),
  getRateLimitHeaders: () => ({}),
}));

import { POST } from '@/app/api/auth/resend-verification/route';

const post = (body: unknown) =>
  POST(
    new Request('http://localhost:3000/api/auth/resend-verification', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

describe('POST /api/auth/resend-verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
