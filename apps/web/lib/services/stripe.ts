import Stripe from 'stripe';
import { logger } from '@/lib/logger';
import {
  customerInput,
  parseStripeApiBase,
  paymentIntentId as paymentIntentIdSchema,
  paymentIntentInput,
  refundInput,
} from './stripe-inputs';

/**
 * Stripe API version this integration is written against. The SDK major
 * (22.x) is pinned to the same version, so request and response types match.
 * See docs/upgrades/stripe.md before changing it.
 */
export const STRIPE_API_VERSION = '2026-08-26.dahlia' as const;

/**
 * Optional override for the Stripe API origin, e.g. `http://localhost:12111`
 * for stripe-mock in tests and CI. Loopback hosts only (see stripe-inputs).
 */
function apiHostOptions(): Pick<Stripe.StripeConfig, 'host' | 'port' | 'protocol'> {
  const base = process.env.STRIPE_API_BASE_URL;
  return base ? parseStripeApiBase(base) : {};
}

// Initialize Stripe client
function getStripeClient(): Stripe | null {
  const secretKey = process.env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    logger.warn('STRIPE_SECRET_KEY is not set. Stripe functionality will be disabled.');
    return null;
  }

  return new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION,
    typescript: true,
    timeout: 30000, // 30s timeout to prevent hanging requests
    ...apiHostOptions(),
  });
}

export const stripe = getStripeClient();

// Helper to check if Stripe is enabled
export function isStripeEnabled(): boolean {
  return stripe !== null;
}

// Create a payment intent for an invoice
export async function createPaymentIntent(params: {
  amount: number; // in cents
  currency: string;
  invoiceId: string;
  customerId?: string;
  stripeAccountId?: string;
  metadata?: Record<string, string>;
}): Promise<Stripe.PaymentIntent | null> {
  if (!stripe) {
    throw new Error('Stripe is not configured');
  }

  const { amount, currency, invoiceId, customerId, stripeAccountId, metadata } =
    paymentIntentInput.parse(params);

  // Use invoice ID + amount as idempotency key to prevent duplicate payment intents
  const idempotencyKey = `pi_${invoiceId}_${amount}_${currency}`;

  const paymentIntent = await stripe.paymentIntents.create(
    {
      amount,
      currency,
      metadata: {
        invoiceId,
        ...metadata,
      },
      ...(customerId && { customer: customerId }),
      ...(stripeAccountId && {
        transfer_data: { destination: stripeAccountId },
      }),
      automatic_payment_methods: {
        enabled: true,
      },
    },
    { idempotencyKey }
  );

  return paymentIntent;
}

// Create or retrieve a Stripe customer
export async function getOrCreateCustomer(params: {
  email: string;
  name: string;
  metadata?: Record<string, string>;
}): Promise<Stripe.Customer | null> {
  if (!stripe) {
    throw new Error('Stripe is not configured');
  }

  const { email, name, metadata } = customerInput.parse(params);

  // Search for existing customer
  const existingCustomers = await stripe.customers.list({
    email,
    limit: 1,
  });

  const existingCustomer = existingCustomers.data[0];
  if (existingCustomer) {
    return existingCustomer;
  }

  // Create new customer
  const customer = await stripe.customers.create({
    email,
    name,
    metadata,
  });

  return customer;
}

// Retrieve a payment intent
export async function retrievePaymentIntent(
  paymentIntentId: string
): Promise<Stripe.PaymentIntent | null> {
  if (!stripe) {
    throw new Error('Stripe is not configured');
  }

  return stripe.paymentIntents.retrieve(paymentIntentIdSchema.parse(paymentIntentId));
}

// Create a refund
export async function createRefund(params: {
  paymentIntentId: string;
  amount?: number; // partial refund in cents, full refund if not specified
  reason?: Stripe.RefundCreateParams.Reason;
}): Promise<Stripe.Refund | null> {
  if (!stripe) {
    throw new Error('Stripe is not configured');
  }

  const { paymentIntentId, amount, reason } = refundInput.parse(params);

  const refund = await stripe.refunds.create({
    payment_intent: paymentIntentId,
    ...(amount !== undefined && { amount }),
    ...(reason && { reason }),
  });

  return refund;
}

// Construct webhook event from payload
export function constructWebhookEvent(
  payload: string | Buffer,
  signature: string
): Stripe.Event {
  if (!stripe) {
    throw new Error('Stripe is not configured');
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
  }

  return stripe.webhooks.constructEvent(payload, signature, webhookSecret);
}

// Get public key for client-side
export function getPublicKey(): string | null {
  return process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? null;
}

// Types for webhook handling
export type StripeWebhookEvent = Stripe.Event;
export type PaymentIntentSucceeded = Stripe.PaymentIntent;
export type PaymentIntentFailed = Stripe.PaymentIntent;
