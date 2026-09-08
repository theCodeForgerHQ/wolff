import type { Prisma } from '@wolff/database';
import { writeOutboxEvent } from '../outbox';

type Tx = Prisma.TransactionClient;

/** Invoices that cannot take a payment: never issued, or cancelled. */
const CLOSED = ['draft', 'voided'];

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Credits a completed provider payment to its invoice, under a lock on the
 * invoice row so two payments arriving together cannot both read the old
 * amountPaid. The money has been taken either way, so nothing here refuses
 * it; what the invoice records is guarded instead:
 *
 * - a draft or voided invoice is not credited (crediting would mark it paid
 *   without being issued, or revive a cancelled one); a
 *   `payment_on_closed_invoice` event says the money needs a refund;
 * - an invoice is credited at most what is still due, so amountPaid never
 *   passes the total; the rest is recorded as an `overpayment` event.
 */
export async function creditInvoice(
  tx: Tx,
  input: {
    invoiceId: string;
    workspaceId: string;
    amount: number;
    paymentId: string;
    method: 'razorpay' | 'stripe';
  }
): Promise<void> {
  const { invoiceId, workspaceId, amount, paymentId, method } = input;
  await tx.$queryRaw`
    SELECT id FROM invoices WHERE id = ${invoiceId} AND workspace_id = ${workspaceId} FOR UPDATE`;
  const invoice = await tx.invoice.findUniqueOrThrow({
    where: { id: invoiceId, workspaceId },
    select: { total: true, amountPaid: true, paidAt: true, status: true },
  });

  if (CLOSED.includes(invoice.status)) {
    await tx.invoiceEvent.create({
      data: {
        invoiceId,
        eventType: 'payment_on_closed_invoice',
        actorType: 'system',
        metadata: { paymentId, amount, method, invoiceStatus: invoice.status },
      },
    });
    return;
  }

  const total = Number(invoice.total);
  const before = Number(invoice.amountPaid);
  const credited = round2(Math.max(0, Math.min(amount, total - before)));
  const excess = round2(amount - credited);
  const amountPaid = round2(before + credited);
  const fullyPaid = amountPaid >= total;

  await tx.invoice.update({
    where: { id: invoiceId, workspaceId },
    data: {
      amountPaid,
      amountDue: Math.max(0, round2(total - amountPaid)),
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
  if (excess > 0) {
    await tx.invoiceEvent.create({
      data: {
        invoiceId,
        eventType: 'overpayment',
        actorType: 'system',
        metadata: { paymentId, amount, credited, excess, method },
      },
    });
  }

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
