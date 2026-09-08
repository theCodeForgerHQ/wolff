// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@wolff/database', () => ({
  prisma: new Proxy(
    {},
    {
      get: () => {
        throw new Error('no db in this test');
      },
    }
  ),
}));

import { GET } from '@/app/api/cron/reset-demo/route';
import { constantTimeEquals } from '@/lib/constant-time';

const call = (authorization?: string) =>
  GET(
    new Request('http://localhost:3000/api/cron/reset-demo', {
      headers: authorization ? { authorization } : {},
    })
  );

describe('reset-demo cron authorization', () => {
  beforeEach(() => vi.stubEnv('CRON_SECRET', 's3cret-value'));
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    undefined,
    'Bearer wrong',
    'Bearer s3cret-valu',
    'Bearer s3cret-value-and-more',
    's3cret-value',
  ])('refuses %s', async (authorization) => {
    expect((await call(authorization)).status).toBe(401);
  });

  it('compares in constant time', () => {
    expect(constantTimeEquals('Bearer a', 'Bearer a')).toBe(true);
    expect(constantTimeEquals('Bearer a', 'Bearer b')).toBe(false);
    expect(constantTimeEquals('short', 'longer value')).toBe(false);
  });
});
