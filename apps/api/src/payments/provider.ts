import type { Prisma } from '@wolff/database';
import { decrypt } from '@wolff/core/encryption';
import { CoreError } from '@wolff/core/errors';
import Stripe from 'stripe';
import Razorpay from 'razorpay';

export type PaymentProvider = 'stripe' | 'razorpay';

export interface InvoiceForPayment {
  id: string;
  workspaceId: string;
  clientId: string;
  total: number;
  currency: string;
  status: string;
  invoiceNumber: string;
  client: {
    email: string | null;
    name: string;
    phone: string | null;
  } | null;
}

export interface PaymentSettingsForProvider {
  stripeAccountId: string | null;
  chargesEnabled: boolean;
  razorpayKeyId: string | null;
  razorpayKeySecretEnc: string | null;
  defaultProviderByCurrency: Record<string, PaymentProvider>;
}

export type PaymentLinkResult =
  | {
      provider: 'stripe';
      url: string;
      sessionId: string;
    }
  | {
      provider: 'razorpay';
      orderId: string;
      amount: number;
      currency: string;
      keyId: string;
      prefill: {
        name?: string;
        email?: string;
        contact?: string;
      };
    };

export interface PaymentProviderClients {
  stripe: Stripe;
  razorpay: Razorpay;
}

const DEFAULT_PROVIDER: PaymentProvider = 'stripe';

export function resolveProvider(
  requested: PaymentProvider | undefined,
  currency: string,
  settings: PaymentSettingsForProvider
): PaymentProvider {
  if (requested && ['stripe', 'razorpay'].includes(requested)) return requested;
  return (
    settings.defaultProviderByCurrency[currency] ??
    settings.defaultProviderByCurrency['*'] ??
    DEFAULT_PROVIDER
  );
}

function toSmallestCurrencyUnit(total: number | bigint | unknown): number {
  const value = typeof total === 'bigint' ? Number(total) : Number(total ?? 0);
  if (!Number.isFinite(value) || value < 0) {
    throw new CoreError('validation_error', 'Invalid invoice total');
  }
  return Math.round(value * 100);
}

export async function createStripeCheckout(
  stripe: Stripe,
  invoice: InvoiceForPayment,
  settings: PaymentSettingsForProvider,
  appUrl: string
): Promise<PaymentLinkResult> {
  if (!settings.stripeAccountId || !settings.chargesEnabled) {
    throw new CoreError(
      'not_configured',
      'Stripe Connect is not configured or charges are not enabled'
    );
  }

  const amount = toSmallestCurrencyUnit(invoice.total);
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency: invoice.currency.toLowerCase(),
              product_data: { name: `Invoice ${invoice.invoiceNumber}` },
              unit_amount: amount,
            },
            quantity: 1,
          },
        ],
        customer_email: invoice.client?.email ?? undefined,
        success_url: `${appUrl}/invoices/${invoice.id}/paid?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${appUrl}/invoices/${invoice.id}`,
        metadata: { invoiceId: invoice.id },
      },
      { stripeAccount: settings.stripeAccountId }
    );
  } catch {
    throw new CoreError('provider_error', 'Stripe checkout creation failed');
  }

  if (!session.url) {
    throw new CoreError('internal_error', 'Stripe did not return a checkout URL');
  }

  return { provider: 'stripe', url: session.url, sessionId: session.id };
}

export async function createRazorpayOrder(
  razorpay: Razorpay,
  invoice: InvoiceForPayment,
  settings: PaymentSettingsForProvider
): Promise<PaymentLinkResult> {
  if (!settings.razorpayKeyId || !settings.razorpayKeySecretEnc) {
    throw new CoreError('not_configured', 'Razorpay keys are not configured');
  }

  const keySecret = decrypt(settings.razorpayKeySecretEnc);
  if (
    keySecret === settings.razorpayKeySecretEnc &&
    settings.razorpayKeySecretEnc.startsWith('enc:')
  ) {
    throw new CoreError('not_configured', 'Cannot decrypt Razorpay secret');
  }

  const amount = toSmallestCurrencyUnit(invoice.total);
  let order: { id?: string };
  try {
    order = await razorpay.orders.create({
      amount,
      currency: invoice.currency.toUpperCase(),
      receipt: invoice.id.slice(0, 40),
      notes: { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber },
    });
  } catch {
    throw new CoreError('provider_error', 'Razorpay order creation failed');
  }

  if (!order.id) {
    throw new CoreError('internal_error', 'Razorpay did not return an order id');
  }

  return {
    provider: 'razorpay',
    orderId: order.id,
    amount,
    currency: invoice.currency.toUpperCase(),
    keyId: settings.razorpayKeyId,
    prefill: {
      name: invoice.client?.name ?? undefined,
      email: invoice.client?.email ?? undefined,
      contact: invoice.client?.phone ?? undefined,
    },
  };
}

export async function createPaymentLink(
  clients: PaymentProviderClients,
  invoice: InvoiceForPayment,
  settings: PaymentSettingsForProvider,
  opts: { provider?: PaymentProvider; appUrl: string }
): Promise<PaymentLinkResult> {
  if (['paid', 'voided', 'draft'].includes(invoice.status)) {
    throw new CoreError(
      'validation_error',
      `Cannot create payment link for ${invoice.status} invoice`
    );
  }

  const provider = resolveProvider(opts.provider, invoice.currency, settings);

  if (provider === 'razorpay') {
    return createRazorpayOrder(clients.razorpay, invoice, settings);
  }

  return createStripeCheckout(clients.stripe, invoice, settings, opts.appUrl);
}
