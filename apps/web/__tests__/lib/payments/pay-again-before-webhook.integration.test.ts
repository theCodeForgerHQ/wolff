// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * A client pays, reloads the invoice before Stripe's webhook has arrived and
 * clicks Pay again. The second checkout call finds the pending payment row
 * and a PaymentIntent that Stripe already reports as `succeeded`.
 *
 * The webhook is the only place that credits the invoice, so the checkout
 * call must leave the row `pending`. Runs against a real Postgres
 * (TEST_DATABASE_URL, as in CI) because the bug was in how the two writes
 * interact, which a mocked client can't show.
 */
const url = process.env.TEST_DATABASE_URL;

const stripeMocks = vi.hoisted(() => ({
  retrievePaymentIntent: vi.fn(),
  cancelPaymentIntent: vi.fn(),
  createPaymentIntent: vi.fn(),
  getOrCreateCustomer: vi.fn(),
}));

vi.mock('@wolff/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wolff/database')>();
  return { ...actual, prisma: actual.createPrisma(process.env.TEST_DATABASE_URL) };
});

vi.mock('@/lib/services/stripe', () => ({
  isStripeEnabled: () => true,
  ...stripeMocks,
}));

// The portal path authenticates by access token; the session lookup is unused.
vi.mock('@/lib/workspace/get-current-workspace', () => ({
  getCurrentUserWorkspace: vi.fn(),
}));

vi.mock('@/lib/services/email', () => ({
  sendPaymentReceivedEmail: vi.fn().mockResolvedValue({ success: true }),
}));

import { prisma } from '@wolff/database';
import { createInvoicePaymentIntent, processPaymentWebhook } from '@/lib/payments/internal';

describe.skipIf(!url)('Pay clicked again before the webhook lands (Postgres)', () => {
  const run = randomUUID();
  const paymentIntentId = `pi_${run.replace(/-/g, '')}`;
  let workspaceId = '';
  let invoiceId = '';
  let accessToken = '';
  let paymentId = '';

  beforeAll(async () => {
    const workspace = await prisma.workspace.create({
      data: {
        name: 'Pay Again Test',
        slug: `pay-again-${run}`,
        paymentSettings: {
          create: {
            stripeAccountId: 'acct_payAgainTest',
            stripeOnboardingComplete: true,
            chargesEnabled: true,
            payoutsEnabled: true,
          },
        },
        clients: { create: { name: 'Client', email: `client-${run}@wolff.test` } },
      },
      include: { clients: true },
    });
    workspaceId = workspace.id;

    const invoice = await prisma.invoice.create({
      data: {
        workspaceId,
        clientId: workspace.clients[0]!.id,
        invoiceNumber: 'INV-PAY-AGAIN',
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
            stripePaymentIntentId: paymentIntentId,
          },
        },
      },
      include: { payments: true },
    });
    invoiceId = invoice.id;
    accessToken = invoice.accessToken;
    paymentId = invoice.payments[0]!.id;
  });

  afterAll(async () => {
    if (invoiceId) {
      await prisma.invoiceEvent.deleteMany({ where: { invoiceId } });
      await prisma.payment.deleteMany({ where: { invoiceId } });
      await prisma.invoice.deleteMany({ where: { id: invoiceId } });
    }
    if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.$disconnect();
  });

  it('reports the payment as already received and leaves the row pending', async () => {
    stripeMocks.retrievePaymentIntent.mockResolvedValue({
      id: paymentIntentId,
      status: 'succeeded',
      amount: 25_000,
    });

    const result = await createInvoicePaymentIntent(invoiceId, accessToken);

    expect(result).toMatchObject({ success: false, alreadyReceived: true });
    expect(result.clientSecret).toBeUndefined();
    expect(stripeMocks.createPaymentIntent).not.toHaveBeenCalled();

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.status).toBe('pending');
    expect(await prisma.payment.count({ where: { invoiceId } })).toBe(1);
  });

  it('lets the webhook that arrives afterwards mark the invoice paid', async () => {
    const result = await processPaymentWebhook(paymentIntentId, 'succeeded', 'ch_payAgain');

    expect(result.success).toBe(true);
    const invoice = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      include: { payments: true },
    });
    expect(invoice.status).toBe('paid');
    expect(Number(invoice.amountPaid)).toBe(250);
    expect(Number(invoice.amountDue)).toBe(0);
    expect(invoice.paidAt).not.toBeNull();
    expect(invoice.payments.map((p) => p.status)).toEqual(['completed']);
  });

  it('credits the invoice once when the webhook is delivered twice', async () => {
    await processPaymentWebhook(paymentIntentId, 'succeeded', 'ch_payAgain');

    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(Number(invoice.amountPaid)).toBe(250);
  });
});
