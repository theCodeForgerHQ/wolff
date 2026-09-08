/**
 * Internal payment operations that should NOT be exposed as server actions.
 * This file intentionally does NOT have 'use server' directive.
 *
 * These functions are called from webhook handlers and API routes only.
 */

import { unexpiredAccessToken } from '@/lib/portal/token';
import { prisma } from '@wolff/database';
import {
  isStripeEnabled,
  cancelPaymentIntent,
  createPaymentIntent,
  getOrCreateCustomer,
  retrievePaymentIntent,
} from '@/lib/services/stripe';
import { getCurrentUserWorkspace } from '@/lib/workspace/get-current-workspace';
import { sendPaymentReceivedEmail } from '@/lib/services/email';
import { formatCurrency } from '@/lib/utils';
import type { PaymentIntentResult } from './types';
import { domainEvents } from '@/lib/events/emitter';
import { logger } from '@/lib/logger';
import { fromMinorUnits, toMinorUnits } from '@wolff/core/payments';

const PAYMENT_ALREADY_RECEIVED =
  'We have already received a payment for this invoice. It will show as paid shortly.';

/**
 * Create payment intent for invoice (called from checkout API route).
 * Amount is always determined server-side from the invoice record.
 */
export async function createInvoicePaymentIntent(
  invoiceId: string,
  accessToken?: string
): Promise<PaymentIntentResult> {
  if (!isStripeEnabled()) {
    return { success: false, error: 'Stripe payments are not available' };
  }

  try {
    // Use accessToken for public checkout (unauthenticated), or workspace-scoped query for authenticated users
    let invoice;
    if (accessToken) {
      invoice = await prisma.invoice.findFirst({
        where: { id: invoiceId, accessToken, deletedAt: null, ...unexpiredAccessToken() },
        include: {
          client: true,
          workspace: { include: { paymentSettings: true } },
        },
      });
    } else {
      // Authenticated path: require workspace scope
      const { workspaceId } = await getCurrentUserWorkspace();
      invoice = await prisma.invoice.findFirst({
        where: { id: invoiceId, workspaceId, deletedAt: null },
        include: {
          client: true,
          workspace: { include: { paymentSettings: true } },
        },
      });
    }

    if (!invoice) {
      return { success: false, error: 'Invoice not found' };
    }

    if (invoice.status === 'paid') {
      return { success: false, error: 'Invoice is already paid' };
    }

    if (invoice.status === 'voided') {
      return { success: false, error: 'Invoice has been voided' };
    }

    // A draft has not been issued (for GST, not through the Rule 46 gate);
    // a payment would move it to paid without ever being issued. The
    // apps/api payment link refuses drafts for the same reason.
    if (invoice.status === 'draft') {
      return { success: false, error: 'Invoice is still a draft and cannot be paid yet' };
    }

    // Verify workspace has a connected Stripe account with charges enabled
    const paymentSettings = invoice.workspace.paymentSettings;
    if (!paymentSettings?.stripeAccountId) {
      return {
        success: false,
        error: 'Payment processing is not configured. Please complete Stripe onboarding.',
      };
    }
    if (!paymentSettings.stripeOnboardingComplete) {
      return {
        success: false,
        error: 'Stripe account setup is incomplete. Please complete onboarding first.',
      };
    }

    const amountToPay = Number(invoice.amountDue);
    if (amountToPay <= 0) {
      return { success: false, error: 'No amount due on this invoice' };
    }

    // Get currency from invoice model (falls back to settings for legacy data)
    const settings = invoice.settings as Record<string, unknown>;
    const currency = (invoice.currency || (settings?.currency as string) || 'USD').toLowerCase();

    // Check for existing pending payment intent to prevent duplicates
    const existingPayment = await prisma.payment.findFirst({
      where: {
        invoiceId: invoice.id,
        status: 'pending',
        stripePaymentIntentId: { not: null },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existingPayment?.stripePaymentIntentId) {
      // Retrieve the existing payment intent from Stripe to get a fresh client secret
      try {
        const existingIntent = await retrievePaymentIntent(existingPayment.stripePaymentIntentId);
        // If the intent is still usable, verify amount matches current amountDue
        if (
          existingIntent.status === 'requires_payment_method' ||
          existingIntent.status === 'requires_confirmation'
        ) {
          if (existingIntent.amount === toMinorUnits(amountToPay, currency)) {
            return {
              success: true,
              clientSecret: existingIntent.client_secret ?? undefined,
              paymentIntentId: existingIntent.id,
            };
          }
          // Amount changed — cancel stale intent and create a fresh one
          await cancelPaymentIntent(existingIntent.id);
          await prisma.payment.update({
            where: { id: existingPayment.id },
            data: { status: 'failed' },
          });
        }
        // The client already paid (or the payment is settling) and the
        // webhook hasn't arrived yet, e.g. they reloaded and clicked Pay
        // again. Leave the row pending: processPaymentWebhook is the only
        // place that credits the invoice, and it skips rows that are no
        // longer pending.
        if (existingIntent.status === 'succeeded' || existingIntent.status === 'processing') {
          return { success: false, alreadyReceived: true, error: PAYMENT_ALREADY_RECEIVED };
        }
        // A cancelled intent can't be paid; retire the row and start again.
        if (existingIntent.status === 'canceled') {
          await prisma.payment.update({
            where: { id: existingPayment.id },
            data: { status: 'failed' },
          });
        }
      } catch {
        // Stripe retrieval failed — mark stale and create a new one
        await prisma.payment.update({
          where: { id: existingPayment.id },
          data: { status: 'failed' },
        });
      }
    }

    // Bug #18: Validate currency is supported by Stripe before creating PaymentIntent
    const SUPPORTED_CURRENCIES = [
      'usd',
      'eur',
      'gbp',
      'cad',
      'aud',
      'jpy',
      'inr',
      'sgd',
      'hkd',
      'nzd',
      'chf',
      'sek',
      'nok',
      'dkk',
      'mxn',
      'brl',
    ];
    if (!SUPPORTED_CURRENCIES.includes(currency)) {
      return {
        success: false,
        error: `Unsupported currency: ${currency.toUpperCase()}. Please update the invoice currency.`,
      };
    }

    // Get or create Stripe customer
    const customer = await getOrCreateCustomer({
      email: invoice.client.email,
      name: invoice.client.company || invoice.client.name,
      metadata: {
        clientId: invoice.client.id,
        workspaceId: invoice.workspaceId,
      },
    });

    // Every earlier intent for this invoice left a payment row behind, so
    // their count numbers this attempt (see paymentIntentIdempotencyKey).
    const attempt = await prisma.payment.count({
      where: { invoiceId: invoice.id, stripePaymentIntentId: { not: null } },
    });

    // Create payment intent (route funds to connected Stripe account)
    const paymentIntent = await createPaymentIntent({
      amount: toMinorUnits(amountToPay, currency),
      currency,
      invoiceId: invoice.id,
      customerId: customer?.id,
      stripeAccountId: paymentSettings.stripeAccountId,
      attempt,
      metadata: {
        workspaceId: invoice.workspaceId,
        invoiceNumber: invoice.invoiceNumber,
        clientId: invoice.clientId,
      },
    });

    if (!paymentIntent) {
      return { success: false, error: 'Failed to create payment intent' };
    }

    // Create pending payment record
    await prisma.payment.create({
      data: {
        invoiceId: invoice.id,
        workspaceId: invoice.workspaceId,
        amount: amountToPay,
        currency,
        paymentMethod: 'card',
        status: 'pending',
        stripePaymentIntentId: paymentIntent.id,
      },
    });

    return {
      success: true,
      clientSecret: paymentIntent.client_secret ?? undefined,
      paymentIntentId: paymentIntent.id,
    };
  } catch (error) {
    logger.error({ err: error }, 'Failed to create payment intent');
    return { success: false, error: 'Failed to create payment' };
  }
}

/**
 * Process Stripe Connect account.updated webhook.
 * Updates local PaymentSettings when Stripe notifies us of account changes.
 *
 * NOT a server action - only callable from server-side webhook handler.
 */
export async function processAccountUpdate(account: {
  id: string;
  charges_enabled?: boolean;
  payouts_enabled?: boolean;
  details_submitted?: boolean;
  requirements?: {
    currently_due?: string[] | null;
    past_due?: string[] | null;
  } | null;
}): Promise<void> {
  const paymentSettings = await prisma.paymentSettings.findFirst({
    where: { stripeAccountId: account.id },
  });

  if (!paymentSettings) {
    logger.warn({ stripeAccountId: account.id }, 'No workspace found for Stripe account');
    return;
  }

  const chargesEnabled = account.charges_enabled ?? false;
  const payoutsEnabled = account.payouts_enabled ?? false;
  const onboardingComplete = chargesEnabled && payoutsEnabled;

  let status = 'pending';
  if (onboardingComplete) {
    status = 'active';
  } else if (account.requirements?.past_due?.length) {
    status = 'past_due';
  } else if (account.requirements?.currently_due?.length) {
    status = 'incomplete';
  }

  await prisma.paymentSettings.update({
    where: { workspaceId: paymentSettings.workspaceId },
    data: {
      stripeAccountStatus: status,
      stripeOnboardingComplete: onboardingComplete,
      chargesEnabled,
      payoutsEnabled,
    },
  });
}

/**
 * Process Stripe charge.refunded webhook.
 *
 * NOT a server action - only callable from server-side webhook handler.
 */
export async function processRefundWebhook(
  paymentIntentId: string,
  amountRefundedCents: number
): Promise<{ success: boolean }> {
  try {
    const payment = await prisma.payment.findFirst({
      where: { stripePaymentIntentId: paymentIntentId, status: 'completed' },
      include: { invoice: { select: { workspaceId: true } } },
    });

    if (!payment) {
      logger.warn({ paymentIntentId }, 'Completed payment not found for refund');
      return { success: false };
    }

    const refundAmount = fromMinorUnits(amountRefundedCents, payment.currency);
    // Bug #15: Use tolerance for floating-point comparison to avoid missing full refunds
    const isFullRefund = refundAmount >= Number(payment.amount) - 0.01;

    await prisma.$transaction(async (tx) => {
      // Read invoice INSIDE the transaction to avoid stale data from concurrent webhooks
      const invoice = await tx.invoice.findUniqueOrThrow({
        where: { id: payment.invoiceId },
      });

      // Update payment with refund info
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: isFullRefund ? 'refunded' : 'completed',
          refundedAt: new Date(),
          refundAmount,
          refundReason: 'Refunded via Stripe',
        },
      });

      // Recalculate invoice amounts using fresh data from within the transaction
      const invoiceTotal = Number(invoice.total);
      const currentAmountPaid = Number(invoice.amountPaid);
      const newAmountPaid = Math.max(0, currentAmountPaid - refundAmount);
      const newAmountDue = Math.max(0, invoiceTotal - newAmountPaid);

      let newStatus = invoice.status;
      if (newAmountPaid <= 0) {
        newStatus = 'sent'; // Fully refunded, back to sent
      } else if (newAmountPaid < invoiceTotal) {
        newStatus = 'partial';
      }

      await tx.invoice.update({
        where: { id: payment.invoiceId },
        data: {
          amountPaid: newAmountPaid,
          amountDue: newAmountDue,
          status: newStatus,
          ...(newAmountPaid <= 0 && { paidAt: null }),
        },
      });

      // Create audit event
      await tx.invoiceEvent.create({
        data: {
          invoiceId: payment.invoiceId,
          eventType: 'payment_refunded',
          actorType: 'system',
          metadata: {
            paymentId: payment.id,
            refundAmount,
            isFullRefund,
          },
        },
      });
    });

    try {
      domainEvents.emit({
        type: 'payment.refunded',
        payload: {
          paymentId: payment.id,
          workspaceId: payment.invoice.workspaceId,
          amount: refundAmount,
        },
      });
    } catch {}

    return { success: true };
  } catch (error) {
    logger.error({ err: error }, 'Failed to process refund webhook');
    return { success: false };
  }
}

/**
 * Process Stripe webhook for payment completion.
 *
 * NOT a server action - only callable from server-side webhook handler.
 */
export async function processPaymentWebhook(
  paymentIntentId: string,
  status: 'succeeded' | 'failed',
  chargeId?: string,
  receiptUrl?: string
): Promise<{ success: boolean }> {
  try {
    const payment = await prisma.payment.findFirst({
      where: { stripePaymentIntentId: paymentIntentId },
      include: {
        invoice: {
          include: {
            client: { select: { name: true, email: true } },
            workspace: { select: { name: true } },
          },
        },
      },
    });

    if (!payment) {
      logger.warn({ paymentIntentId }, 'Payment not found for payment intent');
      return { success: false };
    }

    // A credited payment is final: a repeated success must not credit the
    // invoice again, and a decline event that arrives late must not undo it.
    // `failed` is not final. Stripe reuses the PaymentIntent when the client
    // retries with another card, so a success can follow a decline.
    if (payment.status === 'completed' || payment.status === 'refunded') {
      logger.info({ paymentIntentId }, 'Payment already settled, skipping webhook');
      return { success: true };
    }

    if (status === 'succeeded') {
      const paymentAmount = Number(payment.amount);
      const total = Number(payment.invoice.total);

      // Use interactive transaction with serializable isolation to prevent
      // concurrent webhooks from double-crediting amountPaid
      await prisma.$transaction(async (tx) => {
        // Mark payment as completed
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: 'completed',
            processedAt: new Date(),
            stripeChargeId: chargeId,
            stripeReceiptUrl: receiptUrl,
          },
        });

        // Atomically increment amountPaid and recalculate amountDue
        const updatedInvoice = await tx.invoice.update({
          where: { id: payment.invoiceId },
          data: {
            amountPaid: { increment: paymentAmount },
          },
        });

        const newAmountPaid = Number(updatedInvoice.amountPaid);
        const newAmountDue = Math.max(0, total - newAmountPaid);
        const newInvoiceStatus = newAmountPaid >= total ? 'paid' : 'partial';

        await tx.invoice.update({
          where: { id: payment.invoiceId },
          data: {
            amountDue: newAmountDue,
            status: newInvoiceStatus,
            ...(!payment.invoice.paidAt && { paidAt: new Date() }),
          },
        });

        // Create event
        await tx.invoiceEvent.create({
          data: {
            invoiceId: payment.invoiceId,
            eventType: 'payment_received',
            actorType: 'system',
            metadata: {
              paymentId: payment.id,
              amount: paymentAmount,
              method: 'stripe',
            },
          },
        });
      });
      try {
        domainEvents.emit({
          type: 'payment.received',
          payload: {
            paymentId: payment.id,
            invoiceId: payment.invoiceId,
            workspaceId: payment.invoice.workspaceId,
            amount: paymentAmount,
          },
        });
      } catch {}

      // Send payment confirmation email (fire-and-forget, don't block webhook)
      sendPaymentReceivedEmail({
        to: payment.invoice.client.email,
        clientName: payment.invoice.client.name,
        invoiceNumber: payment.invoice.invoiceNumber,
        businessName: payment.invoice.workspace.name,
        amount: formatCurrency(paymentAmount, payment.invoice.currency),
        receiptUrl: receiptUrl || undefined,
        rateLimitKey: `workspace:${payment.invoice.workspaceId}`,
      }).catch((err) => logger.error({ err }, 'Failed to send payment confirmation email'));
    } else {
      // Payment failed
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'failed' },
      });
    }

    return { success: true };
  } catch (error) {
    logger.error({ err: error }, 'Failed to process payment webhook');
    return { success: false };
  }
}
