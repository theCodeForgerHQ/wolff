import type { Prisma } from '@wolff/database';
import { writeOutboxEvent } from '../outbox';

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
      });
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
      const cents = object.amount_refunded;
      if (typeof cents !== 'number' || !Number.isInteger(cents) || cents < 0) {
        throw new Error('charge.refunded with an invalid amount_refunded');
      }
      await applyRefund(tx, intentId, cents);
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
  input: { paymentIntentId: string; chargeId?: string; receiptUrl?: string }
): Promise<void> {
  const payment = await lockPaymentByIntent(tx, input.paymentIntentId);
  if (!payment) return;

  // A credited payment is final: a repeated success must not credit the
  // invoice again. `failed` is not final, because Stripe reuses the
  // PaymentIntent when the client retries with another card.
  if (payment.status === 'completed' || payment.status === 'refunded') return;

  const { workspaceId } = payment.invoice;
  const amount = Number(payment.amount);
  const total = Number(payment.invoice.total);

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

  const credited = await tx.invoice.update({
    where: { id: payment.invoiceId, workspaceId },
    data: { amountPaid: { increment: amount } },
    select: { amountPaid: true },
  });
  const amountPaid = Number(credited.amountPaid);
  const fullyPaid = amountPaid >= total;

  await tx.invoice.update({
    where: { id: payment.invoiceId, workspaceId },
    data: {
      amountDue: Math.max(0, total - amountPaid),
      status: fullyPaid ? 'paid' : 'partial',
      ...(!payment.invoice.paidAt && { paidAt: new Date() }),
    },
  });

  await tx.invoiceEvent.create({
    data: {
      invoiceId: payment.invoiceId,
      eventType: 'payment_received',
      actorType: 'system',
      metadata: { paymentId: payment.id, amount, method: 'stripe' },
    },
  });

  await writeOutboxEvent(tx, {
    workspaceId,
    type: 'payment.received',
    aggregateType: 'payment',
    aggregateId: payment.id,
    payload: { paymentId: payment.id, invoiceId: payment.invoiceId, workspaceId, amount },
  });
  if (fullyPaid) {
    await writeOutboxEvent(tx, {
      workspaceId,
      type: 'invoice.paid',
      aggregateType: 'invoice',
      aggregateId: payment.invoiceId,
      payload: { invoiceId: payment.invoiceId, workspaceId, amount: amountPaid },
    });
  }
  await writeOutboxEvent(tx, {
    workspaceId,
    type: 'email.payment_received',
    aggregateType: 'payment',
    aggregateId: payment.id,
    payload: { paymentId: payment.id },
  });
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
 * `amountRefundedCents` is Stripe's running total for the charge, so the
 * change applied to the invoice is the difference from what is already
 * recorded. A redelivered or out-of-order event therefore changes nothing.
 */
export async function applyRefund(
  tx: Tx,
  paymentIntentId: string,
  amountRefundedCents: number
): Promise<void> {
  const payment = await lockPaymentByIntent(tx, paymentIntentId);
  if (!payment || payment.status !== 'completed') return;

  const { workspaceId } = payment.invoice;
  const refundedTotal = amountRefundedCents / 100;
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
