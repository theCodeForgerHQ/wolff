import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma, withTenantGuard } from '@wolff/database';
import {
  MAX_PROCESSING_ATTEMPTS,
  processProviderEvent,
  recordProviderEvent,
  redriveStaleProviderEvents,
} from './provider-events';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('provider webhook events (Postgres)', () => {
  const base = createPrisma(url);
  const db = withTenantGuard(base, { mode: 'throw' });
  const run = randomUUID().replace(/-/g, '');
  let workspaceId = '';
  let clientId = '';
  let n = 0;
  let invoiceId = '';
  let intent = '';

  const stripeEvent = (type: string, object: Record<string, unknown>) => ({
    id: `evt_${run}_${++n}`,
    type,
    data: { object },
  });
  const succeeded = () =>
    stripeEvent('payment_intent.succeeded', {
      id: intent,
      latest_charge: { id: `ch_${intent}`, receipt_url: 'https://pay.example.test/receipt' },
    });
  const failed = () => stripeEvent('payment_intent.payment_failed', { id: intent });
  const record = (event: { id: string; type: string }, outbox = true) =>
    recordProviderEvent(db, {
      provider: 'stripe',
      eventId: event.id,
      type: event.type,
      payload: event,
      outbox,
    });
  const invoice = () =>
    base.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { payments: true } });
  const outboxTypes = async () =>
    (
      await base.outboxEvent.findMany({
        where: { workspaceId, aggregateId: { in: [invoiceId, ...(await paymentIds())] } },
        orderBy: { type: 'asc' },
      })
    ).map((e) => e.type);
  const paymentIds = async () =>
    (await base.payment.findMany({ where: { invoiceId } })).map((p) => p.id);

  beforeAll(async () => {
    const workspace = await base.workspace.create({
      data: {
        name: 'Provider Events',
        slug: `provider-events-${run}`,
        clients: { create: { name: 'Client', email: `client-${run}@example.test` } },
      },
      include: { clients: true },
    });
    workspaceId = workspace.id;
    clientId = workspace.clients[0]!.id;
  });

  beforeEach(async () => {
    intent = `pi_${run}_${++n}`;
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
            currency: 'usd',
            paymentMethod: 'card',
            stripePaymentIntentId: intent,
          },
        },
      },
    });
    invoiceId = created.id;
  });

  afterAll(async () => {
    await base.outboxEvent.deleteMany({
      where: {
        OR: [
          { workspaceId },
          { aggregateType: 'provider_webhook_event', payload: { path: ['run'], equals: run } },
        ],
      },
    });
    await base.providerWebhookEvent.deleteMany({
      where: { eventId: { startsWith: `evt_${run}` } },
    });
    await base.invoiceEvent.deleteMany({ where: { invoice: { workspaceId } } });
    await base.payment.deleteMany({ where: { workspaceId } });
    await base.invoice.deleteMany({ where: { workspaceId } });
    await base.workspace.deleteMany({ where: { id: workspaceId } });
    await base.$disconnect();
  });

  it('stores the event and its reconcile job in one step', async () => {
    const event = succeeded();

    const result = await record(event);

    expect(result.outcome).toBe('recorded');
    const row = await base.providerWebhookEvent.findUniqueOrThrow({ where: { id: result.id } });
    expect(row).toMatchObject({ provider: 'stripe', eventId: event.id, status: 'received' });
    const jobs = await base.outboxEvent.findMany({ where: { aggregateId: result.id } });
    expect(jobs.map((j) => [j.type, j.status])).toEqual([['payment.reconcile', 'pending']]);
  });

  it('credits the invoice when the event is processed, and announces it', async () => {
    const { id } = await record(succeeded());

    expect(await processProviderEvent(db, id)).toBe('processed');

    const paid = await invoice();
    expect(paid).toMatchObject({ status: 'paid' });
    expect(Number(paid.amountPaid)).toBe(250);
    expect(Number(paid.amountDue)).toBe(0);
    expect(paid.payments[0]).toMatchObject({
      status: 'completed',
      stripeChargeId: `ch_${intent}`,
      stripeReceiptUrl: 'https://pay.example.test/receipt',
    });
    expect(await outboxTypes()).toEqual([
      'email.payment_received',
      'invoice.paid',
      'payment.received',
    ]);
    const row = await base.providerWebhookEvent.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('processed');
    expect(row.processedAt).not.toBeNull();
  });

  it('processes an event delivered to the old and the new endpoint once', async () => {
    const event = succeeded();
    // The old Next.js route records without a job and processes inline; the
    // new API route records with a job. Stripe sends the same event to both.
    const viaOld = await record(event, false);
    const viaNew = await record(event, true);

    expect(viaOld.outcome).toBe('recorded');
    expect(viaNew).toMatchObject({ outcome: 'redriven', id: viaOld.id });
    expect(viaNew.outboxEventId).toBeTruthy();

    const outcomes = await Promise.all([
      processProviderEvent(db, viaOld.id),
      processProviderEvent(db, viaNew.id),
    ]);

    expect(outcomes.sort()).toEqual(['already_processed', 'processed']);
    expect(Number((await invoice()).amountPaid)).toBe(250);
    expect(await base.invoiceEvent.count({ where: { invoiceId } })).toBe(1);
  });

  it('answers a redelivery of a processed event without a new job', async () => {
    const event = succeeded();
    const first = await record(event);
    await processProviderEvent(db, first.id);

    const again = await record(event);

    expect(again).toEqual({ outcome: 'duplicate', id: first.id });
    expect(await base.outboxEvent.count({ where: { aggregateId: first.id } })).toBe(1);
  });

  it('queues one new job for a redelivery of an event that was never processed', async () => {
    const event = succeeded();
    const first = await record(event);
    // The first job was lost: mark it finished without processing the event.
    await base.outboxEvent.updateMany({
      where: { aggregateId: first.id },
      data: { status: 'failed' },
    });

    expect((await record(event)).outcome).toBe('redriven');
    expect((await record(event)).outcome).toBe('duplicate');

    expect(
      await base.outboxEvent.count({ where: { aggregateId: first.id, status: 'pending' } })
    ).toBe(1);
  });

  it('credits the invoice when a retry succeeds on the same intent after a decline', async () => {
    await processProviderEvent(db, (await record(failed())).id);
    expect((await invoice()).payments[0]!.status).toBe('failed');

    await processProviderEvent(db, (await record(succeeded())).id);
    await processProviderEvent(db, (await record(failed())).id);

    const paid = await invoice();
    expect(paid.payments[0]!.status).toBe('completed');
    expect(paid.status).toBe('paid');
    expect(Number(paid.amountPaid)).toBe(250);
  });

  it('leaves the event unprocessed and rolls everything back when applying it throws', async () => {
    const event = stripeEvent('charge.refunded', {
      payment_intent: intent,
      amount_refunded: 'oops',
    });
    const { id } = await record(event);

    await expect(processProviderEvent(db, id)).rejects.toThrow();

    const row = await base.providerWebhookEvent.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('received');
    expect(row.lastError).toBeTruthy();
    expect((await invoice()).status).toBe('sent');
  });

  it('reverses the credit on a full refund', async () => {
    await processProviderEvent(db, (await record(succeeded())).id);

    await processProviderEvent(
      db,
      (
        await record(
          stripeEvent('charge.refunded', { payment_intent: intent, amount_refunded: 25_000 })
        )
      ).id
    );

    const refunded = await invoice();
    expect(refunded.payments[0]).toMatchObject({ status: 'refunded' });
    expect(Number(refunded.amountPaid)).toBe(0);
    expect(Number(refunded.amountDue)).toBe(250);
    expect(refunded.status).toBe('sent');
    expect(refunded.paidAt).toBeNull();
    expect(await outboxTypes()).toContain('payment.refunded');
  });

  it('marks an event it has no handler for as processed', async () => {
    const { id } = await record(stripeEvent('customer.created', { id: 'cus_1' }));

    expect(await processProviderEvent(db, id)).toBe('processed');
  });

  it('marks an event for an unknown payment as processed, without side effects', async () => {
    const { id } = await record(
      stripeEvent('payment_intent.succeeded', { id: `pi_unknown_${run}`, latest_charge: null })
    );

    expect(await processProviderEvent(db, id)).toBe('processed');
  });
  it('dead-letters an event that keeps failing, and stops re-driving it', async () => {
    // A refund with an impossible amount fails every time it is applied.
    const poison = stripeEvent('charge.refunded', { payment_intent: intent, amount_refunded: -1 });
    const { id } = await record(poison, false);

    for (let i = 0; i < MAX_PROCESSING_ATTEMPTS; i++) {
      await expect(processProviderEvent(db, id)).rejects.toThrow();
    }

    const row = await base.providerWebhookEvent.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: 'failed', attempts: MAX_PROCESSING_ATTEMPTS });
    expect(row.lastError).toMatch(/amount_refunded/);
    // The sweeper only re-drives `received` events, so nothing is queued.
    const later = new Date(Date.now() + 3_600_000);
    await redriveStaleProviderEvents(db, { now: later });
    expect(await base.outboxEvent.count({ where: { aggregateId: id } })).toBe(0);
    // And a further attempt does nothing.
    await expect(processProviderEvent(db, id)).resolves.toBe('dead_lettered');
  });
});
