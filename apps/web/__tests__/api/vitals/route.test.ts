// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/redis', () => ({ getRedis: () => null }));

import { POST } from '@/app/api/vitals/route';

const send = (ip: string) =>
  POST(
    new NextRequest('http://localhost/api/vitals', {
      method: 'POST',
      body: JSON.stringify({ name: 'LCP', value: 1234 }),
      headers: { 'x-forwarded-for': ip, 'content-type': 'application/json' },
    })
  );

describe('POST /api/vitals', () => {
  it('accepts a vital', async () => {
    expect((await send('203.0.113.1')).status).toBe(204);
  });

  it('limits one client to 60 reports a minute', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await send('203.0.113.2')).status);

    expect(statuses.slice(0, 60).every((s) => s === 204)).toBe(true);
    expect(statuses[60]).toBe(429);
    // Another client is not affected.
    expect((await send('203.0.113.3')).status).toBe(204);
  });
});
