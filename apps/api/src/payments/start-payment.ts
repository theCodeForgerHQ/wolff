import type { Db } from '@wolff/core/context';
import { CoreError } from '@wolff/core/errors';
import Razorpay from 'razorpay';
import Stripe from 'stripe';
import {
  createPaymentLink,
  type PaymentLinkResult,
  type PaymentProvider,
  type PaymentProviderClients,
} from './provider';

/** Provider clients from the environment, for when none are injected (tests inject). */
export function defaultPaymentClients(): PaymentProviderClients {
  return {
    stripe: new Stripe(process.env.STRIPE_SECRET_KEY ?? 'sk_test_placeholder', {
      apiVersion: '2026-08-26.dahlia',
      typescript: true,
    }),
    razorpay: new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID ?? 'rzp_test_placeholder',
      key_secret: process.env.RAZORPAY_KEY_SECRET ?? 'secret_placeholder',
    }),
  };
}

export interface InvoiceToPay {
  id: string;
  workspaceId: string;
  clientId: string;
  amountDue: unknown;
  currency: string;
  status: string;
  invoiceNumber: string;
  client: { name: string; email: string | null; phone: string | null } | null;
}

/**
 * Opens a Stripe Checkout session or a Razorpay order for what is still due
 * on an invoice, and records the pending payment the provider's webhook will
 * reconcile. Shared by the API-key route and the public widget route, so
 * both charge the same amount through the same checks.
 */
export async function startInvoicePayment(
  db: Db,
  clients: PaymentProviderClients,
  invoice: InvoiceToPay,
  options: { provider?: PaymentProvider; appUrl: string }
): Promise<PaymentLinkResult> {
  const settings = await db.paymentSettings.findFirst({
    where: { workspaceId: invoice.workspaceId },
  });
  if (!settings) throw new CoreError('not_configured', 'Payment settings not found');

  const link = await createPaymentLink(
    clients,
    {
      id: invoice.id,
      workspaceId: invoice.workspaceId,
      clientId: invoice.clientId,
      amountDue: Number(invoice.amountDue),
      currency: invoice.currency,
      status: invoice.status,
      invoiceNumber: invoice.invoiceNumber,
      client: invoice.client,
    },
    {
      stripeAccountId: settings.stripeAccountId,
      chargesEnabled: settings.chargesEnabled,
      razorpayKeyId: settings.razorpayKeyId,
      razorpayKeySecretEnc: settings.razorpayKeySecretEnc,
      defaultProviderByCurrency: (settings.defaultProviderByCurrency as Record<
        string,
        PaymentProvider
      >) ?? { '*': 'stripe' },
    },
    options
  );

  // The pending row the provider webhook reconciles against.
  await db.payment.create({
    data: {
      workspaceId: invoice.workspaceId,
      invoiceId: invoice.id,
      amount: Number(invoice.amountDue),
      currency: invoice.currency,
      status: 'pending',
      provider: link.provider,
      // Razorpay's order, or Stripe's Checkout Session: the id the provider's
      // completion event names.
      providerOrderId: link.provider === 'razorpay' ? link.orderId : link.sessionId,
      stripePaymentIntentId: link.provider === 'stripe' ? link.paymentIntentId : null,
      paymentMethod: link.provider,
    },
  });
  return link;
}
