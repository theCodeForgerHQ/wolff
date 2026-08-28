import { describe, expect, it } from 'vitest';
import { apiV1Rewrites } from '@/lib/config/api-v1-rewrite';

describe('apiV1Rewrites (Phase 6b: /api/v1 served by apps/api)', () => {
  it('sends /api/v1/* to the API before the Next routes are matched', () => {
    expect(apiV1Rewrites({ API_V1_UPSTREAM: 'https://wolff-api.example.app' })).toEqual([
      { source: '/api/v1/:path*', destination: 'https://wolff-api.example.app/v1/:path*' },
    ]);
  });

  it('ignores a trailing slash on the upstream', () => {
    expect(apiV1Rewrites({ API_V1_UPSTREAM: 'https://api.example.app/' })[0]!.destination).toBe(
      'https://api.example.app/v1/:path*'
    );
  });

  it('keeps the Next routes when no upstream is set', () => {
    expect(apiV1Rewrites({})).toEqual([]);
    expect(apiV1Rewrites({ API_V1_UPSTREAM: '' })).toEqual([]);
  });

  it('refuses an upstream that is not an http(s) origin, so the build fails', () => {
    expect(() => apiV1Rewrites({ API_V1_UPSTREAM: 'wolff-api.example.app' })).toThrow(
      /API_V1_UPSTREAM/
    );
    expect(() => apiV1Rewrites({ API_V1_UPSTREAM: 'ftp://api.example.app' })).toThrow(
      /API_V1_UPSTREAM/
    );
    expect(() => apiV1Rewrites({ API_V1_UPSTREAM: 'https://api.example.app/v1' })).toThrow(
      /API_V1_UPSTREAM/
    );
  });
});
