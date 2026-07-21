import { describe, expect, it } from 'vitest';
import { parseLoopbackUrl } from '@/lib/security/loopback';

describe('parseLoopbackUrl', () => {
  it.each(['http://localhost:9099', 'http://127.0.0.1:12111', 'https://[::1]:8443'])(
    'accepts %s',
    (value) => {
      expect(parseLoopbackUrl(value, 'TEST_URL')).toBeInstanceOf(URL);
    }
  );

  it.each([
    ['a public host', 'https://accounts.example.com'],
    ['a private-network host', 'http://10.0.0.5:9099'],
    ['a host that only starts with localhost', 'http://localhost.evil.example'],
    ['a non-http scheme', 'file:///etc/passwd'],
    ['a relative value', '/oidc'],
  ])('rejects %s', (_label, value) => {
    expect(() => parseLoopbackUrl(value, 'TEST_URL')).toThrow(/TEST_URL/);
  });
});
