import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Razorpay signs a webhook with HMAC-SHA256 of the raw body under the
 * webhook secret, hex encoded, in `X-Razorpay-Signature`. Each
 * workspace brings its own Razorpay account, so the secret is per workspace.
 *
 * This is the check `Razorpay.validateWebhookSignature` performs. The
 * `razorpay` package arrives with the payment provider work in Phase 3; the
 * verification is here so the inbound plumbing is complete without it.
 */
export function verifyRazorpaySignature(
  rawBody: string | Buffer,
  signature: string | undefined,
  secret: string
): boolean {
  if (!signature || !secret || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
