import { describe, expect, it } from 'vitest';
import { checkWebhookUrl, isPublicAddress } from './ssrf';

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1', // carrier-grade NAT
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '192.0.0.1',
    '198.18.0.1',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::7f00:1',
    'not-an-ip',
    '',
  ])('treats %s as not public', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.255.255', '2606:4700:4700::1111'])(
    'treats %s as public',
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    }
  );
});

describe('checkWebhookUrl', () => {
  it('accepts https on the default port', () => {
    expect(checkWebhookUrl('https://hooks.example.com/wolff', { requireHttps: true })).toBeNull();
  });

  it.each([
    ['http://hooks.example.com/x', /https/],
    ['ftp://hooks.example.com/x', /https/],
    ['https://user:pass@hooks.example.com/x', /credentials/],
    ['https://127.0.0.1/x', /private/],
    ['https://[::1]/x', /private/],
    ['https://169.254.169.254/latest/meta-data', /private/],
    ['https://localhost/x', /private/],
    ['https://db.internal/x', /private/],
    ['not a url', /valid URL/],
    ['', /valid URL/],
  ])('rejects %s', (url, reason) => {
    expect(checkWebhookUrl(url, { requireHttps: true })).toMatch(reason);
  });

  it('allows http only when https is not required (local development)', () => {
    expect(checkWebhookUrl('http://hooks.example.com/x', { requireHttps: false })).toBeNull();
  });
});
