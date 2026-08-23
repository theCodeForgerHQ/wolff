import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { withoutSessionOnOAuthCallback } from '@/lib/auth/oauth-callback';

const BASE = 'https://wolff.test';

function request(path: string, cookie: string, init: { method?: string; body?: string } = {}) {
  return new NextRequest(`${BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: { cookie, 'x-other': 'kept' },
    ...(init.body !== undefined && { body: init.body }),
  });
}

const SESSION_COOKIES =
  'authjs.session-token=demo-jwt; __Secure-authjs.session-token=demo-jwt; ' +
  '__Secure-authjs.session-token.0=part0; authjs.session-token.1=part1';
const OTHER_COOKIES = 'authjs.pkce.code_verifier=pkce; authjs.state=st; theme=dark';

describe('withoutSessionOnOAuthCallback', () => {
  it('drops every session-token cookie on an OAuth callback and keeps the rest', () => {
    const out = withoutSessionOnOAuthCallback(
      request('/api/auth/callback/google?code=c&state=s', `${SESSION_COOKIES}; ${OTHER_COOKIES}`)
    );

    const names = out.cookies.getAll().map((c) => c.name);
    expect(names.sort()).toEqual(['authjs.pkce.code_verifier', 'authjs.state', 'theme']);
    expect(out.headers.get('x-other')).toBe('kept');
    expect(out.nextUrl.searchParams.get('code')).toBe('c');
  });

  it('applies to every OAuth provider, including a form_post callback with a body', async () => {
    const out = withoutSessionOnOAuthCallback(
      request('/api/auth/callback/github', SESSION_COOKIES, { method: 'POST', body: 'code=c' })
    );

    expect(out.cookies.getAll()).toEqual([]);
    expect(out.method).toBe('POST');
    expect(await out.text()).toBe('code=c');
  });

  it('leaves the credentials callback and other auth routes untouched', () => {
    for (const path of [
      '/api/auth/callback/credentials',
      '/api/auth/session',
      '/api/auth/signin/google',
    ]) {
      const req = request(path, SESSION_COOKIES);
      expect(withoutSessionOnOAuthCallback(req)).toBe(req);
    }
  });

  it('returns the request as is when there is no session cookie', () => {
    const req = request('/api/auth/callback/google', OTHER_COOKIES);
    expect(withoutSessionOnOAuthCallback(req)).toBe(req);
  });
});
