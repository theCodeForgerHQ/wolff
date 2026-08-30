import { describe, expect, it } from 'vitest';
import { apiV1Proxy, apiV1Upstream } from '@/lib/config/api-v1-rewrite';

describe('apiV1Upstream (Phase 6b: /api/v1 served by apps/api)', () => {
  it('reads the upstream origin, ignoring a trailing slash', () => {
    expect(apiV1Upstream({ API_V1_UPSTREAM: 'https://wolff-api.example.app' })).toBe(
      'https://wolff-api.example.app'
    );
    expect(apiV1Upstream({ API_V1_UPSTREAM: 'https://api.example.app/' })).toBe(
      'https://api.example.app'
    );
  });

  it('keeps the Next routes when no upstream is set', () => {
    expect(apiV1Upstream({})).toBeNull();
    expect(apiV1Upstream({ API_V1_UPSTREAM: '' })).toBeNull();
  });

  it('refuses an upstream that is not an http(s) origin, so the build fails', () => {
    for (const bad of [
      'wolff-api.example.app',
      'ftp://api.example.app',
      'https://api.example.app/v1',
    ]) {
      expect(() => apiV1Upstream({ API_V1_UPSTREAM: bad })).toThrow(/API_V1_UPSTREAM/);
    }
  });
});

describe('apiV1Proxy', () => {
  const upstream = 'https://api.example.app';
  const headers = () =>
    new Headers({
      authorization: 'Bearer qc_sk_x',
      cookie: 'authjs.session-token=abc; other=1',
      'content-type': 'application/json',
      'idempotency-key': 'k1',
    });

  it('sends /api/v1/* to <upstream>/v1/* with the query string', () => {
    const target = apiV1Proxy(
      upstream,
      new URL('https://web.example.app/api/v1/quotes/q1/send?x=1'),
      headers()
    );
    expect(target?.url.href).toBe('https://api.example.app/v1/quotes/q1/send?x=1');
  });

  // The API authenticates with keys only; the web app's session cookie is
  // no business of another service.
  it('drops the cookie and keeps the other headers', () => {
    const target = apiV1Proxy(
      upstream,
      new URL('https://web.example.app/api/v1/clients'),
      headers()
    )!;
    expect(target.headers.has('cookie')).toBe(false);
    expect(target.headers.get('authorization')).toBe('Bearer qc_sk_x');
    expect(target.headers.get('idempotency-key')).toBe('k1');
  });

  it('leaves other paths alone', () => {
    for (const path of ['/api/v10/x', '/api/auth/session', '/dashboard', '/api/v1x']) {
      expect(apiV1Proxy(upstream, new URL(`https://web.example.app${path}`), headers())).toBeNull();
    }
    expect(
      apiV1Proxy(upstream, new URL('https://web.example.app/api/v1'), headers())?.url.href
    ).toBe('https://api.example.app/v1');
  });
});
