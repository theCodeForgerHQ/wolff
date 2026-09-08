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
  let otherWorkspaceId = '';

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
        currency: 'INR',
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
        currency: 'INR',
        method: 'card',
        fee: Math.round(amountPaise * 0.02),
      },
    });

  const refundProcessed = (paymentId: string, amountPaise: number) =>
    razorpayEvent('refund.processed', { refund: { payment_id: paymentId, amount: amountPaise } });

  const record = (event: { id: string; event: string }, forWorkspace = workspaceId) =>
    recordProviderEvent(db, {
      provider: 'razorpay',
      workspaceId: forWorkspace,
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
    const other = await base.workspace.create({
      data: { name: 'Another tenant', slug: `razorpay-other-${run}` },
    });
    otherWorkspaceId = other.id;
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
    await base.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
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

  it('adds up partial refunds, and marks the payment refunded when they reach it', async () => {
    await processProviderEvent(db, (await record(captured('pay_6b', 25_000))).id);

    await processProviderEvent(db, (await record(refundProcessed('pay_6b', 10_000))).id);
    await processProviderEvent(db, (await record(refundProcessed('pay_6b', 10_000))).id);

    const twice = await invoice();
    expect(Number(twice.payments[0]!.refundAmount)).toBe(200);
    expect(twice.payments[0]!.status).toBe('completed');
    expect(Number(twice.amountPaid)).toBe(50);

    await processProviderEvent(db, (await record(refundProcessed('pay_6b', 5_000))).id);

    const all = await invoice();
    expect(Number(all.payments[0]!.refundAmount)).toBe(250);
    expect(all.payments[0]!.status).toBe('refunded');
    expect(Number(all.amountPaid)).toBe(0);
  });

  it('refuses a refund that would take more than is left of the payment', async () => {
    await processProviderEvent(db, (await record(captured('pay_6c', 25_000))).id);
    await processProviderEvent(db, (await record(refundProcessed('pay_6c', 20_000))).id);

    const { id } = await record(refundProcessed('pay_6c', 10_000));

    await expect(processProviderEvent(db, id)).rejects.toThrow(/larger than/);
    expect(Number((await invoice()).amountPaid)).toBe(50);
  });

  it('keeps an event for an unknown order unprocessed, to retry, without side effects', async () => {
    const { id } = await record(
      razorpayEvent('order.paid', {
        order: { id: `order_unknown_${run}` },
        payment: { id: 'pay_x' },
      })
    );

    await expect(processProviderEvent(db, id)).rejects.toThrow(/not ready/);
    const row = await base.providerWebhookEvent.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: 'received', attempts: 1 });
    expect((await invoice()).status).toBe('sent');
  });

  it('retries a refund that arrives before its capture, then applies it', async () => {
    const early = await record(refundProcessed('pay_early', 25_000));
    await expect(processProviderEvent(db, early.id)).rejects.toThrow(/not ready/);

    await processProviderEvent(db, (await record(captured('pay_early', 25_000))).id);
    expect(await processProviderEvent(db, early.id)).toBe('processed');
    expect(Number((await invoice()).amountPaid)).toBe(0);
  });
  it('ignores an event that names an order of another workspace', async () => {
    // Another tenant signs an event with its own secret and quotes this
    // workspace's order id. The event belongs to that tenant only.
    const forged = await record(captured('pay_forged', 25_000), otherWorkspaceId);
    const forgedPaid = await record(orderPaid('pay_forged_2', 25_000), otherWorkspaceId);

    await expect(processProviderEvent(db, forged.id)).rejects.toThrow(/not ready/);
    await expect(processProviderEvent(db, forgedPaid.id)).rejects.toThrow(/not ready/);

    const untouched = await invoice();
    expect(untouched.status).toBe('sent');
    expect(Number(untouched.amountPaid)).toBe(0);
    expect(untouched.payments[0]).toMatchObject({ status: 'pending', providerPaymentId: null });
  });

  it('refuses a capture whose amount differs from the payment', async () => {
    const { id } = await record(captured('pay_short', 100));

    await expect(processProviderEvent(db, id)).rejects.toThrow(/amount/);

    const untouched = await invoice();
    expect(untouched.status).toBe('sent');
    expect(untouched.payments[0]!.status).toBe('pending');
  });

  it('refuses a capture in another currency', async () => {
    const event = captured('pay_usd', 25_000);
    (event.payload.payment.entity as Record<string, unknown>).currency = 'USD';
    const { id } = await record(event);

    await expect(processProviderEvent(db, id)).rejects.toThrow(/currency/);

    expect((await invoice()).status).toBe('sent');
  });

  it('stores the workspace the event was delivered for', async () => {
    const { id } = await record(failed('pay_ws'));

    const row = await base.providerWebhookEvent.findUniqueOrThrow({ where: { id } });
    expect(row.workspaceId).toBe(workspaceId);
  });

  it('refuses to record a Razorpay event without the workspace that verified it', async () => {
    const event = failed('pay_nows');

    await expect(
      recordProviderEvent(db, {
        provider: 'razorpay',
        eventId: event.id,
        type: event.event,
        payload: event,
        outbox: true,
      })
    ).rejects.toThrow(/workspace/);
    expect(await base.providerWebhookEvent.count({ where: { eventId: event.id } })).toBe(0);
  });

  it("does not let another workspace's delivery of the same event id re-drive or take the event", async () => {
    const event = failed('pay_shared');
    const mine = await recordProviderEvent(db, {
      provider: 'razorpay',
      workspaceId,
      eventId: event.id,
      type: event.event,
      payload: event,
      outbox: false,
    });

    const theirs = await recordProviderEvent(db, {
      provider: 'razorpay',
      workspaceId: otherWorkspaceId,
      eventId: event.id,
      type: event.event,
      payload: event,
      outbox: true,
    });

    expect(theirs).toEqual({ outcome: 'duplicate', id: mine.id });
    const row = await base.providerWebhookEvent.findUniqueOrThrow({ where: { id: mine.id } });
    expect(row.workspaceId).toBe(workspaceId);
    expect(await base.outboxEvent.count({ where: { aggregateId: mine.id } })).toBe(0);
  });
});
