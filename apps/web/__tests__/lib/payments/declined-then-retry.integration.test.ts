// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * A client's card is declined, then they retry in the same payment form with
 * another card. Stripe reuses the PaymentIntent: it sends
 * `payment_intent.payment_failed` for the decline and later
 * `payment_intent.succeeded` for the same intent id.
 *
 * The decline marks the payment row `failed`. The success that follows must
 * still credit the invoice. Runs against a real Postgres (TEST_DATABASE_URL,
 * as in CI) so the assertions are on stored state, not on mock calls.
 */
const url = process.env.TEST_DATABASE_URL;

vi.mock('@wolff/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wolff/database')>();
  return { ...actual, prisma: actual.createPrisma(process.env.TEST_DATABASE_URL) };
});

vi.mock('@/lib/services/stripe', () => ({
  isStripeEnabled: () => true,
}));

vi.mock('@/lib/workspace/get-current-workspace', () => ({
  getCurrentUserWorkspace: vi.fn(),
}));

vi.mock('@/lib/services/email', () => ({
  sendPaymentReceivedEmail: vi.fn().mockResolvedValue({ success: true }),
}));

import { prisma } from '@wolff/database';
import { processPaymentWebhook } from '@/lib/payments/internal';

describe.skipIf(!url)(
  'Declined card, then a successful retry on the same intent (Postgres)',
  () => {
    const run = randomUUID();
    const paymentIntentId = `pi_${run.replace(/-/g, '')}`;
    let workspaceId = '';
    let invoiceId = '';

    beforeAll(async () => {
      const workspace = await prisma.workspace.create({
        data: {
          name: 'Declined Then Retry Test',
          slug: `declined-retry-${run}`,
          clients: { create: { name: 'Client', email: `client-${run}@wolff.test` } },
        },
        include: { clients: true },
      });
      workspaceId = workspace.id;

      const invoice = await prisma.invoice.create({
        data: {
          workspaceId,
          clientId: workspace.clients[0]!.id,
          invoiceNumber: 'INV-DECLINED-RETRY',
          status: 'sent',
          dueDate: new Date('2026-12-01'),
          total: 250,
          amountDue: 250,
          payments: {
            create: {
              amount: 250,
              currency: 'usd',
              paymentMethod: 'card',
              status: 'pending',
              stripePaymentIntentId: paymentIntentId,
            },
          },
        },
      });
      invoiceId = invoice.id;
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

    const readInvoice = () =>
      prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { payments: true } });

    it('records the decline without touching the invoice', async () => {
      const result = await processPaymentWebhook(paymentIntentId, 'failed');

      expect(result.success).toBe(true);
      const invoice = await readInvoice();
      expect(invoice.payments.map((p) => p.status)).toEqual(['failed']);
      expect(invoice.status).toBe('sent');
      expect(Number(invoice.amountPaid)).toBe(0);
    });

    it('credits the invoice when the retry succeeds on the same intent', async () => {
      const result = await processPaymentWebhook(paymentIntentId, 'succeeded', 'ch_retry');

      expect(result.success).toBe(true);
      const invoice = await readInvoice();
      expect(invoice.payments.map((p) => p.status)).toEqual(['completed']);
      expect(invoice.payments[0]!.stripeChargeId).toBe('ch_retry');
      expect(invoice.status).toBe('paid');
      expect(Number(invoice.amountPaid)).toBe(250);
      expect(Number(invoice.amountDue)).toBe(0);
      expect(invoice.paidAt).not.toBeNull();
    });

    it('keeps the payment completed when a decline event arrives late', async () => {
      const result = await processPaymentWebhook(paymentIntentId, 'failed');

      expect(result.success).toBe(true);
      const invoice = await readInvoice();
      expect(invoice.payments.map((p) => p.status)).toEqual(['completed']);
      expect(invoice.status).toBe('paid');
      expect(Number(invoice.amountPaid)).toBe(250);
    });

    it('credits the invoice once when the success is delivered again', async () => {
      await processPaymentWebhook(paymentIntentId, 'succeeded', 'ch_retry');

      const invoice = await readInvoice();
      expect(Number(invoice.amountPaid)).toBe(250);
      expect(await prisma.invoiceEvent.count({ where: { invoiceId } })).toBe(1);
    });
  }
);
