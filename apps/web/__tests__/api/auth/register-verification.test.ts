// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Registering proves nothing about the address until the link in the email
 * is used. If the email cannot be sent, the account must stay unverified:
 * otherwise anyone could hold a verified account under someone else's
 * address whenever the mailer fails.
 */
const mocks = vi.hoisted(() => ({
  userUpdate: vi.fn(),
  send: vi.fn(),
}));

vi.mock('@wolff/database', () => ({
  prisma: {
    user: { findUnique: vi.fn().mockResolvedValue(null), update: mocks.userUpdate },
    emailVerificationToken: { create: vi.fn() },
  },
}));
vi.mock('@/lib/auth/credentials', () => ({ hashPassword: vi.fn().mockResolvedValue('hash') }));
vi.mock('@/lib/auth/provision-user', () => ({
  createUserWithWorkspace: vi
    .fn()
    .mockResolvedValue({ id: 'u-1', name: 'Victim', email: 'victim@example.com' }),
}));
vi.mock('@/lib/services/email', () => ({ sendVerificationEmail: mocks.send }));
vi.mock('@/lib/csrf', () => ({ validateRequestOrigin: () => true }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ limited: false }),
  getRateLimitHeaders: () => ({}),
  strictRateLimitOptions: {},
}));

import { POST } from '@/app/api/auth/register/route';

const register = () =>
  POST(
    new Request('http://localhost:3000/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Victim',
        email: 'victim@example.com',
        password: 'Str0ng!Passw0rd',
        termsAccepted: true,
      }),
    })
  );

describe('POST /api/auth/register when the verification email fails', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['reports failure', () => mocks.send.mockResolvedValue({ success: false, error: 'down' })],
    ['throws', () => mocks.send.mockRejectedValue(new Error('down'))],
  ])('leaves the account unverified when the sender %s', async (_label, arrange) => {
    arrange();
    const res = await register();

    expect(res.status).toBe(201);
    const verified = mocks.userUpdate.mock.calls.filter((c) => c[0]?.data?.emailVerifiedAt);
    expect(verified).toHaveLength(0);
    expect((await res.json()).message).toMatch(/resend/i);
  });

  it('sends the email and does not verify on success either', async () => {
    mocks.send.mockResolvedValue({ success: true });
    const res = await register();
    expect(res.status).toBe(201);
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });
});
