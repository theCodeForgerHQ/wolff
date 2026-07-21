/**
 * Boundary validation for every value `lib/services/stripe.ts` sends to the
 * Stripe SDK. Callers pass data read from the database or computed from it,
 * but a bad value here costs money (a zero-cent refund used to fall through to
 * a *full* refund) or leaks the secret key (an API origin that isn't
 * loopback), so each input is checked again at the sink.
 */
import { z } from 'zod';
import { parseLoopbackUrl } from '@/lib/security/loopback';

/** Stripe object ids: `<prefix>_<alphanumerics>`, no path characters. */
const stripeId = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9]{1,255}$`), `Invalid ${prefix}_ id`);

/** Amounts in the currency's minor unit, as Stripe expects. */
const minorUnits = z
  .number()
  .int('Amount must be a whole number of minor units')
  .positive('Amount must be greater than zero')
  .max(99_999_999, 'Amount exceeds the Stripe maximum');

const currency = z
  .string()
  .regex(/^[A-Za-z]{3}$/, 'Currency must be a 3-letter ISO code')
  .transform((c) => c.toLowerCase());

/** Stripe metadata limits: 50 keys, 40-char keys, 500-char values. */
const metadata = z
  .record(z.string().min(1).max(40), z.string().max(500))
  .refine((m) => Object.keys(m).length <= 50, 'Stripe allows at most 50 metadata keys');

/** Our own ids (UUIDs and seeded readable ids), used in metadata and idempotency keys. */
const internalId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/, 'Invalid internal id');

export const paymentIntentInput = z.object({
  amount: minorUnits,
  currency,
  invoiceId: internalId,
  customerId: stripeId('cus').optional(),
  stripeAccountId: stripeId('acct').optional(),
  metadata: metadata.default({}),
  // How many PaymentIntents this invoice has had before this one.
  attempt: z.number().int().nonnegative().max(9_999),
});

/**
 * Stripe replays the stored response for a key for 24 hours. The attempt
 * number keeps a double click idempotent (same attempt, same key) while a
 * replacement for a cancelled or failed intent of the same amount gets a
 * new key instead of the old intent back.
 */
export function paymentIntentIdempotencyKey(input: {
  invoiceId: string;
  amount: number;
  currency: string;
  attempt: number;
}): string {
  return `pi_${input.invoiceId}_${input.amount}_${input.currency}_${input.attempt}`;
}

export const customerInput = z.object({
  email: z.email().max(512),
  name: z.string().trim().min(1).max(256),
  metadata: metadata.default({}),
});

export const paymentIntentId = stripeId('pi');

export const refundInput = z.object({
  paymentIntentId,
  // Omitted means a full refund. Present must be a positive integer, so a
  // rounding result of 0 can never be mistaken for "refund everything".
  amount: minorUnits.optional(),
  reason: z.enum(['duplicate', 'fraudulent', 'requested_by_customer']).optional(),
});

/**
 * Parses STRIPE_API_BASE_URL (stripe-mock in tests and CI). Only loopback
 * origins are accepted, so a misconfigured deployment can't send the secret
 * key to another host.
 */
export function parseStripeApiBase(value: string): {
  host: string;
  port: number;
  protocol: 'http' | 'https';
} {
  const url = parseLoopbackUrl(value, 'STRIPE_API_BASE_URL');
  const protocol = url.protocol === 'https:' ? 'https' : 'http';
  return {
    host: url.hostname,
    port: Number(url.port || (protocol === 'https' ? 443 : 80)),
    protocol,
  };
}
