import { createHash } from 'node:crypto';

/**
 * A fixed UUID for a seeded demo record ("client-1" always gives the same
 * one), built like a version 5 UUID from a SHA-1 of the name. Demo records
 * used readable ids such as "demo-client-1", which every UUID check in the
 * app refused: their detail pages answered 404 and forms rejected them.
 */
export function demoId(name: string): string {
  const h = createHash('sha1').update(`wolff-demo:${name}`).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
