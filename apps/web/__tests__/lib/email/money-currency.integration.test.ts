// @vitest-environment node
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * An amount in an email is shown in the currency of its document. Found on
 * the deployed demo: the invoice email for an INR invoice read "$ 5,900.00",
 * because the public API's send route and the payment receipt formatted the
 * amount without passing the currency (so it defaulted to USD). Real Postgres.
 */
const url = process.env.TEST_DATABASE_URL;

vi.mock('@wolff/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wolff/database')>();
  return { ...actual, prisma: actual.createPrisma(process.env.TEST_DATABASE_URL) };
});
const context = vi.hoisted(() => ({ workspaceId: '' }));
vi.mock('@/lib/api/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/auth')>()),
  authenticateApiRequest: vi.fn(async () => ({ context: { workspaceId: context.workspaceId } })),
}));
vi.mock('@/lib/services/stripe', () => ({ isStripeEnabled: () => true }));
vi.mock('@/lib/workspace/get-current-workspace', () => ({ getCurrentUserWorkspace: vi.fn() }));
vi.mock('@/lib/services/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/email')>()),
  sendInvoiceSentEmail: vi.fn().mockResolvedValue({ success: true }),
  sendPaymentReceivedEmail: vi.fn().mockResolvedValue({ success: true }),
}));

import { NextRequest } from 'next/server';
import { prisma } from '@wolff/database';
import { sendInvoiceSentEmail, sendPaymentReceivedEmail } from '@/lib/services/email';
import { processPaymentWebhook } from '@/lib/payments/internal';
import { POST as postSendInvoice } from '@/app/api/v1/invoices/[id]/send/route';

describe.skipIf(!url)('amounts in emails carry the document currency (Postgres)', () => {
  const run = randomUUID().slice(0, 8);
  let clientId = '';

  beforeAll(async () => {
    const workspace = await prisma.workspace.create({
      data: {
        name: 'Rupee Studio',
        slug: `money-currency-${run}`,
        clients: { create: { name: 'Kaveri', email: `kaveri-${run}@example.test` } },
      },
      include: { clients: true },
    });
    context.workspaceId = workspace.id;
    clientId = workspace.clients[0]!.id;
  });

  afterAll(async () => {
    const { workspaceId } = context;
    await prisma.outboxEvent.deleteMany({ where: { workspaceId } });
    await prisma.invoiceEvent.deleteMany({ where: { invoice: { workspaceId } } });
    await prisma.payment.deleteMany({ where: { workspaceId } });
    await prisma.invoice.deleteMany({ where: { workspaceId } });
    await prisma.client.deleteMany({ where: { workspaceId } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.$disconnect();
  });

  const rupeeInvoice = (number: string, extra: Record<string, unknown> = {}) =>
    prisma.invoice.create({
      data: {
        workspaceId: context.workspaceId,
        clientId,
        invoiceNumber: `${number}-${run}`,
        currency: 'INR',
        dueDate: new Date('2026-12-01'),
        subtotal: 5000,
        taxTotal: 900,
        total: 5900,
        amountDue: 5900,
        accessToken: randomBytes(16).toString('hex'),
        ...extra,
      },
    });

  it('the invoice email sent through the API shows rupees', async () => {
    const invoice = await rupeeInvoice('INR-SEND');

    const res = await postSendInvoice(
      new NextRequest(`http://localhost/api/v1/invoices/${invoice.id}/send`, { method: 'POST' }),
      { params: Promise.resolve({ id: invoice.id }) }
    );

    expect(res.status).toBe(200);
    const sent = vi.mocked(sendInvoiceSentEmail).mock.calls.at(-1)![0];
    expect(sent.amount).toBe('₹ 5,900.00');
  });

  it('the payment receipt shows rupees', async () => {
    const intent = `pi_${run}${randomBytes(4).toString('hex')}`;
    await rupeeInvoice('INR-PAY', {
      status: 'sent',
      payments: {
        create: {
          workspaceId: context.workspaceId,
          amount: 5900,
          currency: 'inr',
          paymentMethod: 'card',
          status: 'pending',
          stripePaymentIntentId: intent,
        },
      },
    });

    expect((await processPaymentWebhook(intent, 'succeeded', 'ch_inr')).success).toBe(true);

    const receipt = vi.mocked(sendPaymentReceivedEmail).mock.calls.at(-1)![0];
    expect(receipt.amount).toBe('₹ 5,900.00');
  });
});
