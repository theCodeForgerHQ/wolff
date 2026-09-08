import type { Prisma } from '@wolff/database';
import { writeOutboxEvent } from '../outbox';
import { fromMinorUnits, toMinorUnits } from './minor-units';
import { creditInvoice } from './credit-invoice';
import { ProviderEventNotReadyError } from './not-ready';

/**
 * Applies one verified Stripe event to payments and invoices. Every function
 * here runs inside the transaction that also marks the event processed, so an
 * event is applied completely or not at all.
 *
 * Payments are found by the provider's id, before any workspace is known.
 * That lookup is one of the tenant guard's documented exemptions;
 * the workspace is then taken from the invoice and used for everything else.
 */
type Tx = Prisma.TransactionClient;

interface StripeEventPayload {
  type?: unknown;
  data?: { object?: Record<string, unknown> };
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

export async function applyStripeEvent(tx: Tx, payload: unknown): Promise<void> {
  const event = (payload ?? {}) as StripeEventPayload;
  const object = event.data?.object ?? {};

  switch (event.type) {
    case 'payment_intent.succeeded': {
      const intentId = str(object.id);
      if (!intentId) throw new Error('payment_intent.succeeded without an intent id');
      const charge = object.latest_charge;
      const chargeObject = typeof charge === 'object' && charge !== null ? charge : {};
      await applyPaymentSucceeded(tx, {
        paymentIntentId: intentId,
        chargeId: str(charge) ?? str((chargeObject as Record<string, unknown>).id),
        receiptUrl: str((chargeObject as Record<string, unknown>).receipt_url),
        ...(object.amount_received !== undefined && {
          received: { amount: object.amount_received, currency: object.currency },
        }),
      });
      return;
    }
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      // The session is created before its PaymentIntent exists, so the
      // pending payment only knows the session. This event names both:
      // link them, and credit the payment if the session is paid. Delayed
      // methods complete as 'unpaid' and are credited later by
      // payment_intent.succeeded, which the link now lets through.
      const sessionId = str(object.id);
      if (!sessionId) throw new Error(`${event.type} without a session id`);
      const intent = object.payment_intent;
      const intentId =
        str(intent) ??
        str(
          typeof intent === 'object' && intent ? (intent as Record<string, unknown>).id : undefined
        );
      if (!intentId) return;
      // The session must charge what the pending payment expects. If not,
      // it is left unlinked, so its intent's own success credits nothing
      // either, and the mismatch is recorded on the invoice for review.
      if (!(await sessionMatchesPayment(tx, sessionId, object))) return;
      await linkSessionToIntent(tx, sessionId, intentId);
      if (object.payment_status === 'paid') {
        await applyPaymentSucceeded(tx, { paymentIntentId: intentId });
      }
      return;
    }
    case 'checkout.session.expired':
    case 'checkout.session.async_payment_failed': {
      // The client never paid (the session timed out, or a delayed method
      // was declined): close the pending payment opened for the session.
      const sessionId = str(object.id);
      if (!sessionId) throw new Error(`${event.type} without a session id`);
      await tx.$executeRaw`
        UPDATE payments SET status = 'failed', updated_at = NOW()
        WHERE provider = 'stripe' AND provider_order_id = ${sessionId} AND status = 'pending'`;
      return;
    }
    case 'payment_intent.payment_failed': {
      const intentId = str(object.id);
      if (!intentId) throw new Error('payment_intent.payment_failed without an intent id');
      await applyPaymentFailed(tx, intentId);
      return;
    }
    case 'charge.refunded': {
      const intent = object.payment_intent;
      const intentId =
        str(intent) ??
        str(
          typeof intent === 'object' && intent ? (intent as Record<string, unknown>).id : undefined
        );
      // A refund of a charge that did not come from an invoice payment.
      if (!intentId) return;
      const minor = object.amount_refunded;
      if (typeof minor !== 'number' || !Number.isInteger(minor) || minor < 0) {
        throw new Error('charge.refunded with an invalid amount_refunded');
      }
      await applyRefund(tx, intentId, minor);
      return;
    }
    case 'account.updated':
      await applyAccountUpdate(tx, object);
      return;
    default:
      // Not an event this application acts on.
      return;
  }
}

/**
 * Records the PaymentIntent on the pending payment opened for a Checkout
 * Session. Only an unlinked row is changed, so a redelivery does nothing.
 */
async function linkSessionToIntent(tx: Tx, sessionId: string, paymentIntentId: string) {
  await tx.$executeRaw`
    UPDATE payments SET stripe_payment_intent_id = ${paymentIntentId}, updated_at = NOW()
    WHERE provider = 'stripe' AND provider_order_id = ${sessionId}
      AND stripe_payment_intent_id IS NULL`;
}

/**
 * True when the session's amount_total (smallest unit) and currency equal
 * the pending payment opened for it, or when no such payment exists (there
 * is nothing to credit then). A missing amount counts as a mismatch.
 */
async function sessionMatchesPayment(
  tx: Tx,
  sessionId: string,
  session: Record<string, unknown>
): Promise<boolean> {
  const payment = await tx.payment.findFirst({
    where: { provider: 'stripe', providerOrderId: sessionId },
    select: { id: true, invoiceId: true, amount: true, currency: true },
  });
  if (!payment) return true;
  const expected = toMinorUnits(Number(payment.amount), payment.currency);
  const amountTotal = session.amount_total;
  const currency = str(session.currency)?.toLowerCase();
  if (amountTotal === expected && currency === payment.currency.toLowerCase()) return true;

  await tx.invoiceEvent.create({
    data: {
      invoiceId: payment.invoiceId,
      eventType: 'payment_mismatch',
      actorType: 'system',
      metadata: {
        paymentId: payment.id,
        sessionId,
        expected: { amount: expected, currency: payment.currency.toLowerCase() },
        received: {
          amount: typeof amountTotal === 'number' ? amountTotal : null,
          currency: currency ?? null,
        },
      },
    },
  });
  return false;
}

/** Locks the payment row for the rest of the transaction and loads it. */
async function lockPaymentByIntent(tx: Tx, paymentIntentId: string) {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM payments WHERE stripe_payment_intent_id = ${paymentIntentId}
    ORDER BY created_at DESC LIMIT 1 FOR UPDATE`;
  if (!locked[0]) return null;
  return tx.payment.findUnique({
    where: { id: locked[0].id },
    include: {
      invoice: { select: { id: true, workspaceId: true, total: true, paidAt: true, status: true } },
    },
  });
}

export async function applyPaymentSucceeded(
  tx: Tx,
  input: {
    paymentIntentId: string;
    chargeId?: string;
    receiptUrl?: string;
    /** amount_received and currency of the intent, when the event has them. */
    received?: { amount: unknown; currency: unknown };
  }
): Promise<void> {
  const payment = await lockPaymentByIntent(tx, input.paymentIntentId);
  // The row, or the session link that names this intent, may not exist yet.
  if (!payment) {
    throw new ProviderEventNotReadyError(`no payment for Stripe intent ${input.paymentIntentId}`);
  }

  // A credited payment is final: a repeated success must not credit the
  // invoice again. `failed` is not final, because Stripe reuses the
  // PaymentIntent when the client retries with another card.
  if (payment.status === 'completed' || payment.status === 'refunded') return;

  const { workspaceId } = payment.invoice;
  const amount = Number(payment.amount);

  // The intent must have charged what this payment asked for. A mismatch
  // credits nothing and is recorded on the invoice for review.
  if (input.received && !receivedMatches(payment, input.received)) {
    await tx.invoiceEvent.create({
      data: {
        invoiceId: payment.invoiceId,
        eventType: 'payment_mismatch',
        actorType: 'system',
        metadata: {
          paymentId: payment.id,
          paymentIntentId: input.paymentIntentId,
          expected: {
            amount: toMinorUnits(amount, payment.currency),
            currency: payment.currency.toLowerCase(),
          },
          received: {
            amount: typeof input.received.amount === 'number' ? input.received.amount : null,
            currency: str(input.received.currency) ?? null,
          },
        },
      },
    });
    return;
  }

  await tx.payment.update({
    where: { id: payment.id, workspaceId },
    data: {
      status: 'completed',
      workspaceId,
      processedAt: new Date(),
      stripeChargeId: input.chargeId,
      stripeReceiptUrl: input.receiptUrl,
    },
  });

  await creditInvoice(tx, {
    invoiceId: payment.invoiceId,
    workspaceId,
    amount,
    paymentId: payment.id,
    method: 'stripe',
  });
}

function receivedMatches(
  payment: { amount: unknown; currency: string },
  received: { amount: unknown; currency: unknown }
): boolean {
  return (
    received.amount === toMinorUnits(Number(payment.amount), payment.currency) &&
    str(received.currency)?.toLowerCase() === payment.currency.toLowerCase()
  );
}

export async function applyPaymentFailed(tx: Tx, paymentIntentId: string): Promise<void> {
  const payment = await lockPaymentByIntent(tx, paymentIntentId);
  // Only an open payment can fail; a decline that arrives late must not undo a credit.
  if (!payment || payment.status !== 'pending') return;

  await tx.payment.update({
    where: { id: payment.id, workspaceId: payment.invoice.workspaceId },
    data: { status: 'failed', workspaceId: payment.invoice.workspaceId },
  });
}

/**
 * `amountRefundedMinor` is Stripe's running total for the charge, in the
 * smallest unit of the payment's currency (whole yen for JPY), so the
 * change applied to the invoice is the difference from what is already
 * recorded. A redelivered or out-of-order event therefore changes nothing.
 */
export async function applyRefund(
  tx: Tx,
  paymentIntentId: string,
  amountRefundedMinor: number
): Promise<void> {
  const payment = await lockPaymentByIntent(tx, paymentIntentId);
  if (!payment) {
    throw new ProviderEventNotReadyError(
      `no payment for refunded Stripe intent ${paymentIntentId}`
    );
  }
  // Fully refunded already: a redelivery has nothing left to apply.
  if (payment.status === 'refunded') return;
  // A refund that overtook its payment's success: retry once it is credited.
  if (payment.status !== 'completed') {
    throw new ProviderEventNotReadyError(
      `Stripe refund for payment ${payment.id} before it was credited (${payment.status})`
    );
  }

  const { workspaceId } = payment.invoice;
  const refundedTotal = fromMinorUnits(amountRefundedMinor, payment.currency);
  const delta = refundedTotal - Number(payment.refundAmount ?? 0);
  if (delta <= 0) return;

  // Tolerance for amounts that went through floating point before storage.
  const isFullRefund = refundedTotal >= Number(payment.amount) - 0.01;

  await tx.payment.update({
    where: { id: payment.id, workspaceId },
    data: {
      status: isFullRefund ? 'refunded' : 'completed',
      workspaceId,
      refundedAt: new Date(),
      refundAmount: refundedTotal,
      refundReason: 'Refunded via Stripe',
    },
  });

  const invoice = await tx.invoice.findUniqueOrThrow({
    where: { id: payment.invoiceId, workspaceId },
  });
  const total = Number(invoice.total);
  const amountPaid = Math.max(0, Number(invoice.amountPaid) - delta);

  await tx.invoice.update({
    where: { id: payment.invoiceId, workspaceId },
    data: {
      amountPaid,
      amountDue: Math.max(0, total - amountPaid),
      status: amountPaid <= 0 ? 'sent' : amountPaid < total ? 'partial' : invoice.status,
      ...(amountPaid <= 0 && { paidAt: null }),
    },
  });

  await tx.invoiceEvent.create({
    data: {
      invoiceId: payment.invoiceId,
      eventType: 'payment_refunded',
      actorType: 'system',
      metadata: { paymentId: payment.id, refundAmount: delta, isFullRefund },
    },
  });

  await writeOutboxEvent(tx, {
    workspaceId,
    type: 'payment.refunded',
    aggregateType: 'payment',
    aggregateId: payment.id,
    payload: { paymentId: payment.id, workspaceId, amount: delta },
  });
}

/** Mirrors a connected account's state into the workspace's payment settings. */
export async function applyAccountUpdate(tx: Tx, account: Record<string, unknown>): Promise<void> {
  const accountId = str(account.id);
  if (!accountId) return;

  const settings = await tx.paymentSettings.findFirst({ where: { stripeAccountId: accountId } });
  if (!settings) return;

  const chargesEnabled = account.charges_enabled === true;
  const payoutsEnabled = account.payouts_enabled === true;
  const onboardingComplete = chargesEnabled && payoutsEnabled;
  const requirements = (account.requirements ?? {}) as {
    currently_due?: unknown[] | null;
    past_due?: unknown[] | null;
  };

  let status = 'pending';
  if (onboardingComplete) status = 'active';
  else if (requirements.past_due?.length) status = 'past_due';
  else if (requirements.currently_due?.length) status = 'incomplete';

  await tx.paymentSettings.update({
    where: { workspaceId: settings.workspaceId },
    data: {
      stripeAccountStatus: status,
      stripeOnboardingComplete: onboardingComplete,
      chargesEnabled,
      payoutsEnabled,
    },
  });
}
