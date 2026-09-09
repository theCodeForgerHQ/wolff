import type { Prisma } from '@wolff/database';
import { writeOutboxEvent } from '../outbox';
import { creditInvoice } from './credit-invoice';
import { ProviderEventNotReadyError } from './not-ready';

/**
 * Applies one verified Razorpay event to payments and invoices. Every
 * function here runs inside the transaction that also marks the event
 * processed, so an event is applied completely or not at all.
 *
 * Razorpay amounts are in the smallest currency unit (paise for INR). All
 * stored amounts are in the main unit, so values are divided by 100.
 *
 * Each event was verified with one workspace's webhook secret, and the
 * caller passes that workspace in. Payments are looked up by the provider's
 * order or payment id *within that workspace only*: another tenant that
 * signs an event with its own secret and quotes someone else's order id
 * finds nothing. A capture must also match the payment's amount and
 * currency before the invoice is credited.
 */
type Tx = Prisma.TransactionClient;

interface RazorpayPayload {
  event?: unknown;
  payload?: {
    payment?: { entity?: Record<string, unknown> };
    order?: { entity?: Record<string, unknown> };
    refund?: { entity?: Record<string, unknown> };
  };
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const amountFromPaise = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error('Razorpay amount is not a non-negative integer paise value');
  }
  return value / 100;
};

/** Lock the payment row by Razorpay order id. */
async function lockPaymentByOrderId(tx: Tx, workspaceId: string, orderId: string) {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT p.id FROM payments p JOIN invoices i ON i.id = p.invoice_id
    WHERE p.provider_order_id = ${orderId} AND i.workspace_id = ${workspaceId}
      AND p.provider = 'razorpay'::payment_provider
    ORDER BY p.created_at DESC LIMIT 1 FOR UPDATE OF p`;
  if (!locked[0]) return null;
  return tx.payment.findUnique({
    where: { id: locked[0].id },
    include: {
      invoice: { select: { id: true, workspaceId: true, total: true, paidAt: true, status: true } },
    },
  });
}

/** Lock the payment row by Razorpay payment id. */
async function lockPaymentByPaymentId(tx: Tx, workspaceId: string, paymentId: string) {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT p.id FROM payments p JOIN invoices i ON i.id = p.invoice_id
    WHERE p.provider_payment_id = ${paymentId} AND i.workspace_id = ${workspaceId}
      AND p.provider = 'razorpay'::payment_provider
    ORDER BY p.created_at DESC LIMIT 1 FOR UPDATE OF p`;
  if (!locked[0]) return null;
  return tx.payment.findUnique({
    where: { id: locked[0].id },
    include: {
      invoice: { select: { id: true, workspaceId: true, total: true, paidAt: true, status: true } },
    },
  });
}

export interface RazorpayEventScope {
  /** The workspace whose secret verified the event. */
  workspaceId: string;
}

export async function applyRazorpayEvent(
  tx: Tx,
  payload: unknown,
  { workspaceId }: RazorpayEventScope
): Promise<void> {
  const event = (payload ?? {}) as RazorpayPayload;
  const type = str(event.event);
  const paymentEntity = event.payload?.payment?.entity ?? {};
  const orderEntity = event.payload?.order?.entity ?? {};
  const refundEntity = event.payload?.refund?.entity ?? {};

  switch (type) {
    case 'payment.captured': {
      const paymentId = str(paymentEntity.id);
      if (!paymentId) throw new Error('payment.captured without a payment id');
      const orderId = str(paymentEntity.order_id);
      await applyPaymentCaptured(tx, workspaceId, {
        paymentId,
        orderId,
        amountPaise: paymentEntity.amount,
        currency: paymentEntity.currency,
        method: str(paymentEntity.method),
        feePaise: paymentEntity.fee,
      });
      return;
    }
    case 'payment.failed': {
      const paymentId = str(paymentEntity.id);
      const failedOrderId = str(paymentEntity.order_id);
      if (!paymentId) throw new Error('payment.failed without a payment id');
      await applyPaymentFailed(tx, workspaceId, paymentId, failedOrderId);
      return;
    }
    case 'order.paid': {
      const orderId = str(orderEntity.id);
      const paymentId = str(paymentEntity.id);
      if (!orderId) throw new Error('order.paid without an order id');
      await applyOrderPaid(tx, workspaceId, {
        orderId,
        paymentId,
        amountPaise: paymentEntity.amount,
        currency: paymentEntity.currency ?? orderEntity.currency,
        method: str(paymentEntity.method),
        feePaise: paymentEntity.fee,
      });
      return;
    }
    case 'refund.processed': {
      const paymentId = str(refundEntity.payment_id);
      if (!paymentId) throw new Error('refund.processed without a payment id');
      await applyRefund(tx, workspaceId, paymentId, amountFromPaise(refundEntity.amount));
      return;
    }
    default:
      // Not an event this application acts on.
      return;
  }
}

interface CaptureInput {
  paymentId: string;
  orderId?: string;
  amountPaise: unknown;
  currency: unknown;
  method?: string;
  feePaise?: unknown;
}

/**
 * The money Razorpay says it captured must be the money this payment asked
 * for. A mismatch is not applied; it throws, so the event keeps the error
 * and stays unprocessed for someone to look at.
 */
function assertMatchesPayment(
  payment: { amount: unknown; currency: string },
  amountPaise: unknown,
  currency: unknown
): number {
  const amount = amountFromPaise(amountPaise);
  const expectedPaise = Math.round(Number(payment.amount) * 100);
  if (Math.round(amount * 100) !== expectedPaise) {
    throw new Error(
      `Razorpay amount ${amountPaise} paise does not match the payment (${expectedPaise} paise)`
    );
  }
  if (typeof currency !== 'string' || currency.toUpperCase() !== payment.currency.toUpperCase()) {
    throw new Error(
      `Razorpay currency ${String(currency)} does not match the payment (${payment.currency})`
    );
  }
  return amount;
}

async function applyPaymentCaptured(
  tx: Tx,
  workspaceId: string,
  input: CaptureInput
): Promise<void> {
  let payment = await lockPaymentByPaymentId(tx, workspaceId, input.paymentId);
  if (!payment && input.orderId) {
    payment = await lockPaymentByOrderId(tx, workspaceId, input.orderId);
  }
  if (!payment) {
    throw new ProviderEventNotReadyError(`no payment for Razorpay payment ${input.paymentId}`);
  }

  if (payment.status === 'completed' || payment.status === 'refunded') return;

  const amount = assertMatchesPayment(payment, input.amountPaise, input.currency);

  await tx.payment.update({
    where: { id: payment.id, workspaceId },
    data: {
      status: 'completed',
      processedAt: new Date(),
      providerPaymentId: input.paymentId,
      providerOrderId: input.orderId ?? payment.providerOrderId,
      paymentMethod: input.method ?? payment.paymentMethod,
      providerFee:
        input.feePaise !== undefined ? amountFromPaise(input.feePaise) : payment.providerFee,
    },
  });

  await creditInvoice(tx, {
    invoiceId: payment.invoiceId,
    workspaceId,
    amount,
    paymentId: payment.id,
    method: 'razorpay',
  });
}

async function applyPaymentFailed(
  tx: Tx,
  workspaceId: string,
  paymentId: string,
  orderId?: string
): Promise<void> {
  let payment = await lockPaymentByPaymentId(tx, workspaceId, paymentId);
  if (!payment && orderId) {
    payment = await lockPaymentByOrderId(tx, workspaceId, orderId);
  }
  if (!payment || payment.status !== 'pending') return;

  await tx.payment.update({
    where: { id: payment.id, workspaceId },
    data: { status: 'failed' },
  });
}

interface OrderPaidInput {
  orderId: string;
  paymentId?: string;
  amountPaise: unknown;
  currency: unknown;
  method?: string;
  feePaise?: unknown;
}

async function applyOrderPaid(tx: Tx, workspaceId: string, input: OrderPaidInput): Promise<void> {
  const payment = await lockPaymentByOrderId(tx, workspaceId, input.orderId);
  if (!payment) {
    throw new ProviderEventNotReadyError(`no payment for Razorpay order ${input.orderId}`);
  }

  if (payment.status === 'completed' || payment.status === 'refunded') return;

  const amount = assertMatchesPayment(payment, input.amountPaise, input.currency);

  await tx.payment.update({
    where: { id: payment.id, workspaceId },
    data: {
      status: 'completed',
      processedAt: new Date(),
      providerPaymentId: input.paymentId ?? payment.providerPaymentId,
      providerOrderId: input.orderId,
      paymentMethod: input.method ?? payment.paymentMethod,
      providerFee:
        input.feePaise !== undefined ? amountFromPaise(input.feePaise) : payment.providerFee,
    },
  });

  await creditInvoice(tx, {
    invoiceId: payment.invoiceId,
    workspaceId,
    amount,
    paymentId: payment.id,
    method: 'razorpay',
  });
}

async function applyRefund(
  tx: Tx,
  workspaceId: string,
  paymentId: string,
  refundAmount: number
): Promise<void> {
  const payment = await lockPaymentByPaymentId(tx, workspaceId, paymentId);
  // No row has this payment id until its capture is applied: a refund that
  // overtook the capture is retried, not dropped.
  if (!payment) {
    throw new ProviderEventNotReadyError(`no payment for refunded Razorpay payment ${paymentId}`);
  }
  if (payment.status === 'refunded') return;
  if (payment.status !== 'completed') {
    throw new ProviderEventNotReadyError(
      `Razorpay refund for payment ${payment.id} before it was credited (${payment.status})`
    );
  }
  if (refundAmount <= 0) return;
  // Unlike Stripe's charge.refunded (a running total), each Razorpay
  // refund.processed carries one refund's amount, so refunds add up. A
  // redelivered event is stopped earlier, by its event id.
  const refundedBefore = Number(payment.refundAmount ?? 0);
  const refundedTotal = Math.round((refundedBefore + refundAmount) * 100) / 100;
  if (refundedTotal > Number(payment.amount) + 0.001) {
    throw new Error('Razorpay refund is larger than what is left of the payment');
  }

  const isFullRefund = refundedTotal >= Number(payment.amount) - 0.01;

  await tx.payment.update({
    where: { id: payment.id, workspaceId },
    data: {
      status: isFullRefund ? 'refunded' : 'completed',
      refundedAt: new Date(),
      refundAmount: refundedTotal,
      refundReason: 'Refunded via Razorpay',
    },
  });

  const invoice = await tx.invoice.findUniqueOrThrow({
    where: { id: payment.invoiceId, workspaceId },
  });
  // A voided invoice stays voided, and a payment on it was never credited
  // (payment_on_closed_invoice), so its refund is recorded on the payment
  // and in the events but moves nothing on the invoice.
  if (invoice.status !== 'voided') {
    const total = Number(invoice.total);
    const amountPaid = Math.max(0, Number(invoice.amountPaid) - refundAmount);

    await tx.invoice.update({
      where: { id: payment.invoiceId, workspaceId },
      data: {
        amountPaid,
        amountDue: Math.max(0, total - amountPaid),
        status: amountPaid <= 0 ? 'sent' : amountPaid < total ? 'partial' : invoice.status,
        ...(amountPaid <= 0 && { paidAt: null }),
      },
    });
  }

  await tx.invoiceEvent.create({
    data: {
      invoiceId: payment.invoiceId,
      eventType: 'payment_refunded',
      actorType: 'system',
      metadata: { paymentId: payment.id, refundAmount, isFullRefund },
    },
  });

  await writeOutboxEvent(tx, {
    workspaceId,
    type: 'payment.refunded',
    aggregateType: 'payment',
    aggregateId: payment.id,
    payload: { paymentId: payment.id, workspaceId, amount: refundAmount },
  });
}
