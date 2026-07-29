// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Payments carry the workspace of their invoice so they can be
 * listed and guarded per tenant. The checkout path is the one that creates
 * card payments; this checks the row it writes, against a real Postgres.
 */
const url = process.env.TEST_DATABASE_URL;

vi.mock('@wolff/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wolff/database')>();
  return { ...actual, prisma: actual.createPrisma(process.env.TEST_DATABASE_URL) };
});

vi.mock('@/lib/services/stripe', () => ({
  isStripeEnabled: () => true,
  getOrCreateCustomer: vi.fn().mockResolvedValue({ id: 'cus_test' }),
  createPaymentIntent: vi.fn(async () => ({
    id: `pi_${randomUUID().replace(/-/g, '')}`,
    client_secret: 'secret',
  })),
}));

vi.mock('@/lib/workspace/get-current-workspace', () => ({
  getCurrentUserWorkspace: vi.fn(),
}));

vi.mock('@/lib/services/email', () => ({
  sendPaymentReceivedEmail: vi.fn().mockResolvedValue({ success: true }),
}));

import { prisma } from '@wolff/database';
import { createInvoicePaymentIntent } from '@/lib/payments/internal';

describe.skipIf(!url)('The payment row a checkout creates (Postgres)', () => {
  const run = randomUUID();
  let workspaceId = '';
  let invoiceId = '';
  let accessToken = '';

  beforeAll(async () => {
    const workspace = await prisma.workspace.create({
      data: {
        name: 'Payment Workspace Test',
        slug: `payment-workspace-${run}`,
        paymentSettings: {
          create: {
            stripeAccountId: 'acct_paymentWorkspace',
            stripeOnboardingComplete: true,
            chargesEnabled: true,
            payoutsEnabled: true,
          },
        },
        clients: { create: { name: 'Client', email: `client-${run}@example.test` } },
      },
      include: { clients: true },
    });
    workspaceId = workspace.id;
    const invoice = await prisma.invoice.create({
      data: {
        workspaceId,
        clientId: workspace.clients[0]!.id,
        invoiceNumber: 'INV-PAYMENT-WS',
        status: 'sent',
        dueDate: new Date('2026-12-01'),
        total: 80,
        amountDue: 80,
      },
    });
    invoiceId = invoice.id;
    accessToken = invoice.accessToken;
  });

  afterAll(async () => {
    if (invoiceId) {
      await prisma.payment.deleteMany({ where: { invoiceId } });
      await prisma.invoice.deleteMany({ where: { id: invoiceId } });
    }
    if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.$disconnect();
  });

  it('belongs to the workspace of the invoice', async () => {
    const result = await createInvoicePaymentIntent(invoiceId, accessToken);

    expect(result.success).toBe(true);
    const payments = await prisma.payment.findMany({ where: { invoiceId } });
    expect(payments).toHaveLength(1);
    expect(payments[0]!.workspaceId).toBe(workspaceId);
  });
});
