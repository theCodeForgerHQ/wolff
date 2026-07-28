import { BlockList, isIP } from 'node:net';

/**
 * SSRF guard for outbound webhooks. A workspace chooses the URL we
 * POST to, so it must not be able to point us at our own network: loopback,
 * private ranges, link-local (cloud metadata), and the IPv6 forms that wrap
 * an IPv4 address.
 */
const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3], // multicast, reserved and broadcast
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 127], // unspecified and loopback
  ['64:ff9b::', 96], // NAT64
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(network, prefix, 'ipv6');
}

const MAPPED_V4 = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i;

/** True only for an IP literal that is routable on the public internet. */
export function isPublicAddress(address: string): boolean {
  const mapped = MAPPED_V4.exec(address);
  if (mapped) {
    if (mapped[1]) return isPublicAddress(mapped[1]);
    const high = parseInt(mapped[2]!, 16);
    const low = parseInt(mapped[3]!, 16);
    return isPublicAddress(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }
  const family = isIP(address);
  if (family === 0) return false;
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

const PRIVATE_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];

/**
 * Checks a URL before it is stored or called. Returns the reason it is not
 * acceptable, or null. A hostname still has to be resolved and checked again
 * when the request is made; see `guardedLookup`.
 */
export function checkWebhookUrl(raw: string, options: { requireHttps: boolean }): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Webhook URL must be a valid URL';
  }
  if (url.protocol !== 'https:' && (options.requireHttps || url.protocol !== 'http:')) {
    return 'Webhook URL must use https';
  }
  if (url.username || url.password) return 'Webhook URL must not contain credentials';

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(host) !== 0) {
    return isPublicAddress(host) ? null : 'Webhook URL must not point to a private address';
  }
  if (host === 'localhost' || PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return 'Webhook URL must not point to a private address';
  }
  return null;
}
