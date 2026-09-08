// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A reset token is single use. The route read the token, checked usedAt,
 * then marked it used, so two requests sent at once with the same token
 * both passed the check and both set a password.
 */
const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  claim: vi.fn(),
  userUpdate: vi.fn(),
  sessionDelete: vi.fn(),
}));

vi.mock('@wolff/database', () => {
  const tx = {
    passwordResetToken: { updateMany: mocks.claim, update: mocks.claim },
    user: { update: mocks.userUpdate },
    session: { deleteMany: mocks.sessionDelete },
  };
  return {
    prisma: {
      passwordResetToken: {
        findUnique: mocks.findUnique,
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        delete: vi.fn(),
        updateMany: mocks.claim,
        update: mocks.claim,
      },
      user: { update: mocks.userUpdate },
      session: { deleteMany: mocks.sessionDelete },
      $transaction: vi.fn(async (arg: unknown) =>
        typeof arg === 'function'
          ? (arg as (t: typeof tx) => unknown)(tx)
          : Promise.all(arg as unknown[])
      ),
    },
  };
});
vi.mock('@/lib/csrf', () => ({ validateRequestOrigin: () => true }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ limited: false }),
  getRateLimitHeaders: () => ({}),
}));
vi.mock('bcryptjs', () => ({ hash: vi.fn().mockResolvedValue('new-hash') }));

import { POST } from '@/app/api/auth/reset-password/route';

const reset = () =>
  POST(
    new Request('http://localhost:3000/api/auth/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'raw-token', password: 'N3w!Passw0rd-long' }),
    }) as never
  );

describe('POST /api/auth/reset-password', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue({
      id: 't-1',
      userId: 'u-1',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: { id: 'u-1' },
    });
  });

  it('changes nothing when another request already used the token', async () => {
    // The read saw it unused; by the time of the write another request had
    // claimed it.
    mocks.claim.mockResolvedValue({ count: 0 });
    const res = await reset();
    expect(res.status).toBe(400);
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it('sets the password when this request claims the token', async () => {
    mocks.claim.mockResolvedValue({ count: 1 });
    const res = await reset();
    expect(res.status).toBe(200);
    expect(mocks.userUpdate).toHaveBeenCalled();
  });
});
