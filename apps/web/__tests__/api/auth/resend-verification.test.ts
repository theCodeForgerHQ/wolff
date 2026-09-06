// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  send: vi.fn(),
  rateLimit: vi.fn(),
  afterTasks: [] as (() => unknown)[],
  logError: vi.fn(),
}));

// after() needs a request scope; collect the work and run it like Next does,
// once the response is out.
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (task: () => unknown) => mocks.afterTasks.push(task),
}));
vi.mock('@/lib/logger', () => ({
  logger: { error: mocks.logError, warn: vi.fn(), info: vi.fn() },
}));
const runAfter = async () => {
  for (const task of mocks.afterTasks.splice(0)) await task();
};

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
    mocks.afterTasks.length = 0;
    mocks.findUnique.mockResolvedValue({
      id: 'u-1',
      email: 'new@example.com',
      name: 'New',
      emailVerifiedAt: null,
    });
  });

  it('answers, then sends the email after the response', async () => {
    mocks.send.mockResolvedValue({ success: true });
    const res = await post({ email: 'new@example.com' });
    expect(res.status).toBe(200);
    expect(mocks.send).not.toHaveBeenCalled();

    await runAfter();
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'new@example.com' }));
  });

  // sendVerificationEmail reports failure in its result; it does not throw.
  it('logs a failed send without changing the answer', async () => {
    mocks.send.mockResolvedValue({ success: false, error: 'provider down' });
    const res = await post({ email: 'new@example.com' });
    await runAfter();
    expect(res.status).toBe(200);
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-1' }),
      'Failed to send verification email'
    );
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

    await runAfter();
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

  // Same answer is not enough if the real path is visibly slower (token
  // write and email send): every path takes at least the same minimum.
  it('takes the same minimum time whether or not the account exists', async () => {
    mocks.findUnique.mockResolvedValue(null);
    let started = Date.now();
    await post({ email: 'nobody@example.com' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);

    mocks.findUnique.mockResolvedValue({
      id: 'u-1',
      email: 'new@example.com',
      name: 'N',
      emailVerifiedAt: null,
    });
    mocks.send.mockResolvedValue({ success: true });
    started = Date.now();
    await post({ email: 'new@example.com' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
  });
});
