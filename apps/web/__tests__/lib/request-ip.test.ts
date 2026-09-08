import { describe, expect, it } from 'vitest';
import { requestIp } from '@/lib/request-ip';

const h = (entries: Record<string, string>) => new Headers(entries);
const vercel = { VERCEL: '1' };

describe('requestIp', () => {
  // Rate limits key on this. Entries a client sends itself must not count.
  describe('on Vercel, which sets x-real-ip and overwrites X-Forwarded-For', () => {
    it('takes x-real-ip', () => {
      expect(
        requestIp(h({ 'x-real-ip': '198.51.100.9', 'x-forwarded-for': '1.2.3.4' }), vercel)
      ).toBe('198.51.100.9');
    });
  });

  describe('behind a trusted reverse proxy (TRUSTED_PROXY_HOPS, default 1)', () => {
    it('takes the entry the nearest proxy appended, not what the client sent in front', () => {
      expect(requestIp(h({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7' }), {})).toBe('203.0.113.7');
    });

    it('does not trust x-real-ip, which a client reaching the app can set', () => {
      expect(requestIp(h({ 'x-real-ip': '6.6.6.6', 'x-forwarded-for': '203.0.113.7' }), {})).toBe(
        '203.0.113.7'
      );
    });

    it('counts back the configured number of proxies', () => {
      const headers = h({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7, 10.0.0.2' });
      expect(requestIp(headers, { TRUSTED_PROXY_HOPS: '2' })).toBe('203.0.113.7');
    });
  });

  it('is null when there is nothing to go on', () => {
    expect(requestIp(h({}), {})).toBeNull();
    expect(requestIp(h({ 'x-forwarded-for': ' , ' }), {})).toBeNull();
    expect(
      requestIp(h({ 'x-forwarded-for': '203.0.113.7' }), { TRUSTED_PROXY_HOPS: '2' })
    ).toBeNull();
  });
});
