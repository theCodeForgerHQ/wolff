import { createHmac, timingSafeEqual } from 'node:crypto';
import { PRODUCT_HEADER } from '../brand';

/**
 * Outbound webhook signature:
 * `X-<Product>-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`.
 * The timestamp is signed, so a captured request cannot be replayed later.
 */
export const webhookHeaderNames = {
  signature: `X-${PRODUCT_HEADER}-Signature`,
  eventId: `X-${PRODUCT_HEADER}-Event-Id`,
  apiVersion: `X-${PRODUCT_HEADER}-Api-Version`,
} as const;

export const WEBHOOK_API_VERSION = '2026-10';
export const REPLAY_WINDOW_SECONDS = 300;

function hmac(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function signWebhookPayload(secret: string, body: string, now: Date = new Date()): string {
  const timestamp = Math.floor(now.getTime() / 1000);
  return `t=${timestamp},v1=${hmac(secret, timestamp, body)}`;
}

/**
 * What a receiver does with the header. Used by the tests and the docs; the
 * application only signs.
 */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string,
  now: Date = new Date()
): boolean {
  const parts = new Map(
    header.split(',').map((part) => {
      const [key, ...rest] = part.split('=');
      return [key?.trim() ?? '', rest.join('=')] as const;
    })
  );
  const timestamp = Number(parts.get('t'));
  const signature = parts.get('v1');
  if (!Number.isInteger(timestamp) || !signature) return false;

  const age = Math.abs(Math.floor(now.getTime() / 1000) - timestamp);
  if (age > REPLAY_WINDOW_SECONDS) return false;

  const expected = Buffer.from(hmac(secret, timestamp, body), 'hex');
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
