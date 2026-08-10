// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * GST invoices through the dashboard's server actions, against a
 * real Postgres: FY numbering, engine pricing, the Rule 46 gate on leaving
 * draft, and composition suppliers refused.
 */
const url = process.env.TEST_DATABASE_URL;

vi.mock('@wolff/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wolff/database')>();
  return { ...actual, prisma: actual.createPrisma(process.env.TEST_DATABASE_URL) };
});
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
const workspaceContext = vi.hoisted(() => ({ workspaceId: '', userId: '', role: 'owner' }));
vi.mock('@/lib/workspace/get-current-workspace', () => ({
  getCurrentUserWorkspace: vi.fn(async () => workspaceContext),
}));
vi.mock('@/lib/email/actions', () => ({
  sendTemplatedEmail: vi.fn().mockResolvedValue({ success: true }),
}));
vi.mock('@/lib/notifications/internal', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from '@wolff/database';
import { getFinancialYear } from '@wolff/core/gst';
import {
  createInvoice,
  createInvoiceFromQuote,
  sendInvoice,
  updateInvoiceStatus,
} from '@/lib/invoices/actions';

describe.skipIf(!url)('GST invoices from the dashboard (Postgres)', () => {
  const run = randomUUID().slice(0, 8);
  let clientId = '';

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { email: `gst-owner-${run}@example.test`, name: 'Owner' },
    });
    const workspace = await prisma.workspace.create({
      data: {
        name: 'GST dashboard',
        slug: `gst-dash-${run}`,
        ownerId: user.id,
        members: { create: { userId: user.id, role: 'owner' } },
        businessProfile: {
          create: {
            businessName: 'Kaveri Studio',
            gstin: '33AABCK1234L1Z5',
            stateCode: '33',
            gstRegistrationType: 'regular',
            currency: 'INR',
            address: { line1: '12 Cathedral Road', city: 'Chennai' },
          },
        },
        clients: {
          create: {
            name: 'Ravi Textiles',
            email: `ravi-${run}@example.test`,
            gstin: '33AAACR5055K1Z0',
            stateCode: '33',
            isGstRegistered: true,
            address: { line1: '4 Mount Road', city: 'Chennai' },
          },
        },
      },
      include: { clients: true },
    });
    Object.assign(workspaceContext, { workspaceId: workspace.id, userId: user.id });
    clientId = workspace.clients[0]!.id;
  });

  afterAll(async () => {
    const { workspaceId, userId } = workspaceContext;
    await prisma.invoiceEvent.deleteMany({ where: { invoice: { workspaceId } } });
    await prisma.invoice.deleteMany({ where: { workspaceId } });
    await prisma.quoteEvent.deleteMany({ where: { quote: { workspaceId } } });
    await prisma.quote.deleteMany({ where: { workspaceId } });
    await prisma.numberSequence.deleteMany({ where: { workspaceId } });
    await prisma.client.deleteMany({ where: { workspaceId } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  const draft = (lineItems: Array<Record<string, unknown>>) =>
    createInvoice({
      clientId,
      title: 'Branding',
      dueDate: '2026-12-01',
      lineItems: lineItems as never,
    });

  it('prices with the GST engine and numbers within the financial year', async () => {
    const result = await draft([
      { name: 'Logo design', quantity: 1, rate: 10000, taxRate: 18, hsnSac: '998311' },
    ]);

    expect(result.success).toBe(true);
    const invoice = await prisma.invoice.findFirstOrThrow({
      where: { id: result.invoice!.id },
      include: { lineItems: true },
    });
    expect(invoice).toMatchObject({ supplyType: 'intra', placeOfSupply: '33' });
    expect(Number(invoice.total)).toBe(11800);
    expect(Number(invoice.lineItems[0]!.cgstAmount)).toBe(900);
    const sequence = await prisma.numberSequence.findFirstOrThrow({
      where: { workspaceId: workspaceContext.workspaceId, type: 'invoice' },
    });
    expect(sequence.financialYear).toBe(getFinancialYear());
    expect(invoice.invoiceNumber.length).toBeLessThanOrEqual(16);
  });

  it('keeps an invoice without HSN/SAC in draft and says why', async () => {
    const result = await draft([{ name: 'Consulting', quantity: 1, rate: 5000, taxRate: 18 }]);
    const id = result.invoice!.id;

    const issued = await updateInvoiceStatus(id, 'sent');
    const sent = await sendInvoice(id);

    expect(issued.success).toBe(false);
    expect(issued.error).toMatch(/HSN/);
    expect(sent.success).toBe(false);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).status).toBe('draft');
  });

  it('issues a complete GST invoice', async () => {
    const result = await draft([
      { name: 'Logo design', quantity: 1, rate: 10000, taxRate: 18, hsnSac: '998311' },
    ]);

    expect((await updateInvoiceStatus(result.invoice!.id, 'sent')).success).toBe(true);
  });

  it('prices an invoice converted from a quote with the GST engine', async () => {
    const quote = await prisma.quote.create({
      data: {
        workspaceId: workspaceContext.workspaceId,
        clientId,
        quoteNumber: `Q-${run}`,
        status: 'accepted',
        currency: 'INR',
        subtotal: 10000,
        taxTotal: 1800,
        total: 11800,
        lineItems: {
          create: {
            name: 'Logo design',
            quantity: 1,
            rate: 10000,
            amount: 10000,
            taxRate: 18,
            taxAmount: 1800,
            gstRate: 18,
            hsnSac: '998311',
            itemType: 'services',
          },
        },
      },
    });

    const result = await createInvoiceFromQuote(quote.id);

    expect(result.success).toBe(true);
    const invoice = await prisma.invoice.findFirstOrThrow({
      where: { quoteId: quote.id },
      include: { lineItems: true },
    });
    expect(invoice.supplyType).toBe('intra');
    expect(Number(invoice.lineItems[0]!.sgstAmount)).toBe(900);
    expect((await updateInvoiceStatus(invoice.id, 'sent')).success).toBe(true);
  });

  it('refuses a GST invoice for a composition supplier', async () => {
    await prisma.businessProfile.update({
      where: { workspaceId: workspaceContext.workspaceId },
      data: { gstRegistrationType: 'composition' },
    });
    try {
      const result = await draft([
        { name: 'Logo design', quantity: 1, rate: 10000, taxRate: 18, hsnSac: '998311' },
      ]);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/bill of supply/);
    } finally {
      await prisma.businessProfile.update({
        where: { workspaceId: workspaceContext.workspaceId },
        data: { gstRegistrationType: 'regular' },
      });
    }
  });
});
