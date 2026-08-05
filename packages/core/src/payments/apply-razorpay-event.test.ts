import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma, withTenantGuard } from '@wolff/database';
import { processProviderEvent, recordProviderEvent } from './provider-events';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('Razorpay event application (Postgres)', () => {
  const base = createPrisma(url);
  const db = withTenantGuard(base, { mode: 'throw' });
  const run = randomUUID().replace(/-/g, '');
  let workspaceId = '';
  let clientId = '';
  let n = 0;
  let invoiceId = '';
  let orderId = '';

  const razorpayEvent = (
    event: string,
    payload: {
      payment?: Record<string, unknown>;
      order?: Record<string, unknown>;
      refund?: Record<string, unknown>;
    }
  ) => ({
    id: `evt_${run}_${++n}`,
    event,
    payload: {
      payment: { entity: payload.payment ?? {} },
      order: { entity: payload.order ?? {} },
      refund: { entity: payload.refund ?? {} },
    },
  });

  const captured = (paymentId: string, amountPaise: number) =>
    razorpayEvent('payment.captured', {
      payment: {
        id: paymentId,
        order_id: orderId,
        amount: amountPaise,
        method: 'upi',
        fee: Math.round(amountPaise * 0.02),
      },
    });

  const failed = (paymentId: string) =>
    razorpayEvent('payment.failed', { payment: { id: paymentId, order_id: orderId } });

  const orderPaid = (paymentId: string, amountPaise: number) =>
    razorpayEvent('order.paid', {
      order: { id: orderId },
      payment: {
        id: paymentId,
        order_id: orderId,
        amount: amountPaise,
        method: 'card',
        fee: Math.round(amountPaise * 0.02),
      },
    });

  const refundProcessed = (paymentId: string, amountPaise: number) =>
    razorpayEvent('refund.processed', { refund: { payment_id: paymentId, amount: amountPaise } });

  const record = (event: { id: string; event: string }) =>
    recordProviderEvent(db, {
      provider: 'razorpay',
      eventId: event.id,
      type: event.event,
      payload: event,
      outbox: true,
    });

  const invoice = () =>
    base.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { payments: true } });

  beforeAll(async () => {
    const workspace = await base.workspace.create({
      data: {
        name: 'Razorpay Events',
        slug: `razorpay-events-${run}`,
        clients: { create: { name: 'Client', email: `client-${run}@example.test` } },
      },
      include: { clients: true },
    });
    workspaceId = workspace.id;
    clientId = workspace.clients[0]!.id;
  });

  beforeEach(async () => {
    orderId = `order_${run}_${++n}`;
    const created = await base.invoice.create({
      data: {
        workspaceId,
        clientId,
        invoiceNumber: `INV-${n}`,
        status: 'sent',
        dueDate: new Date('2026-12-01'),
        total: 250,
        amountDue: 250,
        payments: {
          create: {
            workspaceId,
            amount: 250,
            currency: 'inr',
            paymentMethod: 'razorpay',
            provider: 'razorpay',
            providerOrderId: orderId,
          },
        },
      },
    });
    invoiceId = created.id;
  });

  afterAll(async () => {
    await base.outboxEvent.deleteMany({ where: { workspaceId } });
    await base.providerWebhookEvent.deleteMany({
      where: { eventId: { startsWith: `evt_${run}` } },
    });
    await base.invoiceEvent.deleteMany({ where: { invoice: { workspaceId } } });
    await base.payment.deleteMany({ where: { workspaceId } });
    await base.invoice.deleteMany({ where: { workspaceId } });
    await base.workspace.deleteMany({ where: { id: workspaceId } });
    await base.$disconnect();
  });

  it('credits the invoice on payment.captured', async () => {
    const { id } = await record(captured('pay_1', 25_000));

    expect(await processProviderEvent(db, id)).toBe('processed');

    const paid = await invoice();
    expect(paid.status).toBe('paid');
    expect(Number(paid.amountPaid)).toBe(250);
    expect(Number(paid.amountDue)).toBe(0);
    expect(paid.payments[0]).toMatchObject({
      status: 'completed',
      providerPaymentId: 'pay_1',
      providerOrderId: orderId,
      paymentMethod: 'upi',
    });
    expect(Number(paid.payments[0]!.providerFee)).toBe(5);
  });

  it('credits the invoice on order.paid', async () => {
    const { id } = await record(orderPaid('pay_2', 25_000));

    expect(await processProviderEvent(db, id)).toBe('processed');

    const paid = await invoice();
    expect(paid.status).toBe('paid');
    expect(paid.payments[0]).toMatchObject({
      status: 'completed',
      providerPaymentId: 'pay_2',
      providerOrderId: orderId,
      paymentMethod: 'card',
    });
  });

  it('marks the payment failed on payment.failed', async () => {
    const { id } = await record(failed('pay_3'));

    expect(await processProviderEvent(db, id)).toBe('processed');

    expect((await invoice()).payments[0]).toMatchObject({ status: 'failed' });
  });

  it('ignores a late failure after the payment already succeeded', async () => {
    await processProviderEvent(db, (await record(captured('pay_4', 25_000))).id);
    await processProviderEvent(db, (await record(failed('pay_4'))).id);

    const paid = await invoice();
    expect(paid.status).toBe('paid');
    expect(paid.payments[0]!.status).toBe('completed');
  });

  it('reverses the credit on a full refund', async () => {
    await processProviderEvent(db, (await record(captured('pay_5', 25_000))).id);

    await processProviderEvent(db, (await record(refundProcessed('pay_5', 25_000))).id);

    const refunded = await invoice();
    expect(refunded.payments[0]).toMatchObject({ status: 'refunded' });
    expect(Number(refunded.amountPaid)).toBe(0);
    expect(Number(refunded.amountDue)).toBe(250);
    expect(refunded.status).toBe('sent');
  });

  it('applies a partial refund and leaves the invoice partial', async () => {
    await processProviderEvent(db, (await record(captured('pay_6', 25_000))).id);

    await processProviderEvent(db, (await record(refundProcessed('pay_6', 10_000))).id);

    const partial = await invoice();
    expect(partial.payments[0]).toMatchObject({ status: 'completed' });
    expect(Number(partial.amountPaid)).toBe(150);
    expect(Number(partial.amountDue)).toBe(100);
    expect(partial.status).toBe('partial');
  });

  it('marks an event for an unknown order as processed without side effects', async () => {
    const { id } = await record(
      razorpayEvent('order.paid', {
        order: { id: `order_unknown_${run}` },
        payment: { id: 'pay_x' },
      })
    );

    expect(await processProviderEvent(db, id)).toBe('processed');
    expect((await invoice()).status).toBe('sent');
  });
});
