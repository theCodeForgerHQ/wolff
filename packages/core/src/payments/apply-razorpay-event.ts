import type { Prisma } from '@wolff/database';
import { writeOutboxEvent } from '../outbox';

/**
 * Applies one verified Razorpay event to payments and invoices. Every
 * function here runs inside the transaction that also marks the event
 * processed, so an event is applied completely or not at all.
 *
 * Razorpay amounts are in the smallest currency unit (paise for INR). All
 * stored amounts are in the main unit, so values are divided by 100.
 *
 * Payments are found by the provider's order or payment id, before any
 * workspace is known. That lookup is one of the tenant guard's documented
 * exemptions; the workspace is then taken from the invoice.
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
async function lockPaymentByOrderId(tx: Tx, orderId: string) {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM payments WHERE provider_order_id = ${orderId}
    ORDER BY created_at DESC LIMIT 1 FOR UPDATE`;
  if (!locked[0]) return null;
  return tx.payment.findUnique({
    where: { id: locked[0].id },
    include: {
      invoice: { select: { id: true, workspaceId: true, total: true, paidAt: true, status: true } },
    },
  });
}

/** Lock the payment row by Razorpay payment id. */
async function lockPaymentByPaymentId(tx: Tx, paymentId: string) {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM payments WHERE provider_payment_id = ${paymentId}
    ORDER BY created_at DESC LIMIT 1 FOR UPDATE`;
  if (!locked[0]) return null;
  return tx.payment.findUnique({
    where: { id: locked[0].id },
    include: {
      invoice: { select: { id: true, workspaceId: true, total: true, paidAt: true, status: true } },
    },
  });
}

export async function applyRazorpayEvent(tx: Tx, payload: unknown): Promise<void> {
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
      await applyPaymentCaptured(tx, {
        paymentId,
        orderId,
        amountPaise: paymentEntity.amount,
        method: str(paymentEntity.method),
        feePaise: paymentEntity.fee,
      });
      return;
    }
    case 'payment.failed': {
      const paymentId = str(paymentEntity.id);
      const failedOrderId = str(paymentEntity.order_id);
      if (!paymentId) throw new Error('payment.failed without a payment id');
      await applyPaymentFailed(tx, paymentId, failedOrderId);
      return;
    }
    case 'order.paid': {
      const orderId = str(orderEntity.id);
      const paymentId = str(paymentEntity.id);
      if (!orderId) throw new Error('order.paid without an order id');
      await applyOrderPaid(tx, {
        orderId,
        paymentId,
        amountPaise: paymentEntity.amount,
        method: str(paymentEntity.method),
        feePaise: paymentEntity.fee,
      });
      return;
    }
    case 'refund.processed': {
      const paymentId = str(refundEntity.payment_id);
      if (!paymentId) throw new Error('refund.processed without a payment id');
      await applyRefund(tx, paymentId, amountFromPaise(refundEntity.amount));
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
  method?: string;
  feePaise?: unknown;
}

async function applyPaymentCaptured(tx: Tx, input: CaptureInput): Promise<void> {
  let payment = await lockPaymentByPaymentId(tx, input.paymentId);
  if (!payment && input.orderId) {
    payment = await lockPaymentByOrderId(tx, input.orderId);
  }
  if (!payment) return;

  if (payment.status === 'completed' || payment.status === 'refunded') return;

  const amount = amountFromPaise(input.amountPaise);
  const { workspaceId } = payment.invoice;

  await tx.payment.update({
    where: { id: payment.id, workspaceId },
    data: {
      status: 'completed',
      workspaceId,
      processedAt: new Date(),
      providerPaymentId: input.paymentId,
      providerOrderId: input.orderId ?? payment.providerOrderId,
      paymentMethod: input.method ?? payment.paymentMethod,
      providerFee:
        input.feePaise !== undefined ? amountFromPaise(input.feePaise) : payment.providerFee,
    },
  });

  await creditInvoice(tx, payment.invoiceId, workspaceId, amount, payment.id, 'razorpay');
}

async function applyPaymentFailed(tx: Tx, paymentId: string, orderId?: string): Promise<void> {
  let payment = await lockPaymentByPaymentId(tx, paymentId);
  if (!payment && orderId) {
    payment = await lockPaymentByOrderId(tx, orderId);
  }
  if (!payment || payment.status !== 'pending') return;

  await tx.payment.update({
    where: { id: payment.id, workspaceId: payment.invoice.workspaceId },
    data: { status: 'failed', workspaceId: payment.invoice.workspaceId },
  });
}

interface OrderPaidInput {
  orderId: string;
  paymentId?: string;
  amountPaise: unknown;
  method?: string;
  feePaise?: unknown;
}

async function applyOrderPaid(tx: Tx, input: OrderPaidInput): Promise<void> {
  const payment = await lockPaymentByOrderId(tx, input.orderId);
  if (!payment) return;

  if (payment.status === 'completed' || payment.status === 'refunded') return;

  const amount = amountFromPaise(input.amountPaise);
  const { workspaceId } = payment.invoice;

  await tx.payment.update({
    where: { id: payment.id, workspaceId },
    data: {
      status: 'completed',
      workspaceId,
      processedAt: new Date(),
      providerPaymentId: input.paymentId ?? payment.providerPaymentId,
      providerOrderId: input.orderId,
      paymentMethod: input.method ?? payment.paymentMethod,
      providerFee:
        input.feePaise !== undefined ? amountFromPaise(input.feePaise) : payment.providerFee,
    },
  });

  await creditInvoice(tx, payment.invoiceId, workspaceId, amount, payment.id, 'razorpay');
}

async function creditInvoice(
  tx: Tx,
  invoiceId: string,
  workspaceId: string,
  amount: number,
  paymentId: string,
  method: 'razorpay' | 'stripe'
): Promise<void> {
  const invoice = await tx.invoice.findUniqueOrThrow({
    where: { id: invoiceId, workspaceId },
    select: { total: true, amountPaid: true, paidAt: true },
  });
  const total = Number(invoice.total);

  const credited = await tx.invoice.update({
    where: { id: invoiceId, workspaceId },
    data: { amountPaid: { increment: amount } },
    select: { amountPaid: true },
  });
  const amountPaid = Number(credited.amountPaid);
  const fullyPaid = amountPaid >= total;

  await tx.invoice.update({
    where: { id: invoiceId, workspaceId },
    data: {
      amountDue: Math.max(0, total - amountPaid),
      status: fullyPaid ? 'paid' : 'partial',
      ...(!invoice.paidAt && { paidAt: new Date() }),
    },
  });

  await tx.invoiceEvent.create({
    data: {
      invoiceId,
      eventType: 'payment_received',
      actorType: 'system',
      metadata: { paymentId, amount, method },
    },
  });

  await writeOutboxEvent(tx, {
    workspaceId,
    type: 'payment.received',
    aggregateType: 'payment',
    aggregateId: paymentId,
    payload: { paymentId, invoiceId, workspaceId, amount },
  });
  if (fullyPaid) {
    await writeOutboxEvent(tx, {
      workspaceId,
      type: 'invoice.paid',
      aggregateType: 'invoice',
      aggregateId: invoiceId,
      payload: { invoiceId, workspaceId, amount: amountPaid },
    });
  }
  await writeOutboxEvent(tx, {
    workspaceId,
    type: 'email.payment_received',
    aggregateType: 'payment',
    aggregateId: paymentId,
    payload: { paymentId },
  });
}

async function applyRefund(tx: Tx, paymentId: string, refundAmount: number): Promise<void> {
  const payment = await lockPaymentByPaymentId(tx, paymentId);
  if (!payment || payment.status !== 'completed') return;
  if (refundAmount <= 0) return;

  const { workspaceId } = payment.invoice;
  const isFullRefund = refundAmount >= Number(payment.amount) - 0.01;

  await tx.payment.update({
    where: { id: payment.id, workspaceId },
    data: {
      status: isFullRefund ? 'refunded' : 'completed',
      workspaceId,
      refundedAt: new Date(),
      refundAmount,
      refundReason: 'Refunded via Razorpay',
    },
  });

  const invoice = await tx.invoice.findUniqueOrThrow({
    where: { id: payment.invoiceId, workspaceId },
  });
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
