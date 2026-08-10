// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * During the switch to apps/api, Stripe delivers
 * each event to the old Next.js endpoint and to the new API endpoint. Both
 * must dedupe on the same ProviderWebhookEvent table so the event is
 * applied once, whichever arrives first.
 *
 * The new endpoint's path is recordProviderEvent(outbox: true) followed by
 * the payments.reconcile job (processProviderEvent); the API's own tests
 * cover its HTTP layer. Signature checking is stubbed here; it has its own
 * tests.
 */
const url = process.env.TEST_DATABASE_URL;

vi.mock('@wolff/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wolff/database')>();
  return { ...actual, prisma: actual.createPrisma(process.env.TEST_DATABASE_URL) };
});

vi.mock('@/lib/services/stripe', () => ({
  isStripeEnabled: () => true,
  constructWebhookEvent: (body: string) => JSON.parse(body),
}));

// Only the previous inline handler reaches these; they pull in next-auth.
vi.mock('@/lib/workspace/get-current-workspace', () => ({ getCurrentUserWorkspace: vi.fn() }));
vi.mock('@/lib/services/email', () => ({
  sendPaymentReceivedEmail: vi.fn().mockResolvedValue({ success: true }),
}));

import { NextRequest } from 'next/server';
import { prisma, withTenantGuard } from '@wolff/database';
import { processProviderEvent, recordProviderEvent } from '@wolff/core/payments';
import { POST } from '@/app/api/webhooks/stripe/route';

describe.skipIf(!url)('Stripe webhook delivered to the old and the new endpoint (Postgres)', () => {
  const db = withTenantGuard(prisma, { mode: 'throw' });
  const run = randomUUID().replace(/-/g, '');
  let workspaceId = '';
  let n = 0;

  const invoiceWithIntent = async () => {
    const intent = `pi_${run}_${++n}`;
    const client = await prisma.client.create({
      data: { workspaceId, name: 'Client', email: `c-${run}-${n}@example.test` },
    });
    const invoice = await prisma.invoice.create({
      data: {
        workspaceId,
        clientId: client.id,
        invoiceNumber: `CUT-${run.slice(0, 6)}-${n}`,
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
            status: 'pending',
            stripePaymentIntentId: intent,
          },
        },
      },
    });
    const event = {
      id: `evt_${run}_${n}`,
      type: 'payment_intent.succeeded',
      data: { object: { id: intent, latest_charge: `ch_${run}_${n}` } },
    };
    return { invoice, event };
  };

  const oldEndpoint = (event: unknown) =>
    POST(
      new NextRequest('http://localhost/api/webhooks/stripe', {
        method: 'POST',
        body: JSON.stringify(event),
        headers: { 'stripe-signature': 't=1,v1=stub' },
      })
    );

  const newEndpoint = async (event: { id: string; type: string }) => {
    const recorded = await recordProviderEvent(db, {
      provider: 'stripe',
      eventId: event.id,
      type: event.type,
      payload: event,
      outbox: true,
    });
    if (recorded.outcome !== 'duplicate') await processProviderEvent(db, recorded.id);
  };

  const credited = async (invoiceId: string) => {
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    return { status: invoice.status, amountPaid: Number(invoice.amountPaid) };
  };

  beforeAll(async () => {
    const workspace = await prisma.workspace.create({
      data: { name: 'Cutover', slug: `cutover-${run}` },
    });
    workspaceId = workspace.id;
  });

  afterAll(async () => {
    const events = await prisma.providerWebhookEvent.findMany({
      where: { eventId: { startsWith: `evt_${run}` } },
      select: { id: true },
    });
    await prisma.outboxEvent.deleteMany({
      where: { OR: [{ workspaceId }, { aggregateId: { in: events.map((e) => e.id) } }] },
    });
    await prisma.providerWebhookEvent.deleteMany({
      where: { eventId: { startsWith: `evt_${run}` } },
    });
    await prisma.invoiceEvent.deleteMany({ where: { invoice: { workspaceId } } });
    await prisma.payment.deleteMany({ where: { workspaceId } });
    await prisma.invoice.deleteMany({ where: { workspaceId } });
    await prisma.client.deleteMany({ where: { workspaceId } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.$disconnect();
  });

  it('applies the event once when the old endpoint gets it first', async () => {
    const { invoice, event } = await invoiceWithIntent();

    const res = await oldEndpoint(event);
    // The old endpoint records the event where the new one will look.
    const recorded = await prisma.providerWebhookEvent.findMany({ where: { eventId: event.id } });
    expect(recorded.map((r) => r.status)).toEqual(['processed']);
    await newEndpoint(event);

    expect(res.status).toBe(200);
    expect(await credited(invoice.id)).toEqual({ status: 'paid', amountPaid: 250 });
    const rows = await prisma.providerWebhookEvent.findMany({ where: { eventId: event.id } });
    expect(rows).toHaveLength(1);
    const credits = await prisma.invoiceEvent.count({
      where: { invoiceId: invoice.id, eventType: 'payment_received' },
    });
    expect(credits).toBe(1);
  });

  it('applies the event once when the new endpoint gets it first', async () => {
    const { invoice, event } = await invoiceWithIntent();

    await newEndpoint(event);
    const res = await oldEndpoint(event);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, duplicate: true });
    expect(await credited(invoice.id)).toEqual({ status: 'paid', amountPaid: 250 });
  });
});
