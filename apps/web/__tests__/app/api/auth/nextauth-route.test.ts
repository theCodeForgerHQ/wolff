// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * The route, not only the helper: Auth.js must receive the callback request
 * with the session cookies already removed, for GET and POST, and every
 * other auth request unchanged (sign-in, session, the credentials callback).
 */
const seen: NextRequest[] = [];
vi.mock('@/lib/auth', () => ({
  handlers: {
    GET: async (request: NextRequest) => {
      seen.push(request);
      return new Response(null, { status: 204 });
    },
    POST: async (request: NextRequest) => {
      seen.push(request);
      return new Response(null, { status: 204 });
    },
  },
}));

const { GET, POST } = await import('@/app/api/auth/[...nextauth]/route');

const COOKIE = '__Secure-authjs.session-token=demo-jwt; authjs.state=st';

function request(path: string, method = 'GET') {
  return new NextRequest(`https://wolff.test${path}`, {
    method,
    headers: { cookie: COOKIE },
    ...(method === 'POST' && { body: 'code=c' }),
  });
}

function cookieNames(r: NextRequest) {
  return r.cookies.getAll().map((c) => c.name);
}

describe('/api/auth/[...nextauth] route', () => {
  beforeEach(() => {
    seen.length = 0;
  });

  it('hands Auth.js an OAuth callback without the session cookie (GET and POST)', async () => {
    await GET(request('/api/auth/callback/google?code=c&state=s'));
    await POST(request('/api/auth/callback/google', 'POST'));

    expect(seen.map(cookieNames)).toEqual([['authjs.state'], ['authjs.state']]);
    expect(await seen[1]!.text()).toBe('code=c');
  });

  it('passes other auth requests through with their session', async () => {
    await GET(request('/api/auth/session'));
    await POST(request('/api/auth/callback/credentials', 'POST'));

    for (const r of seen) {
      expect(cookieNames(r)).toEqual(['__Secure-authjs.session-token', 'authjs.state']);
    }
  });
});
