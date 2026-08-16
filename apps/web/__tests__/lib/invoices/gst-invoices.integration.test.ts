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
vi.mock('@/lib/api/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/auth')>()),
  authenticateApiRequest: vi.fn(async () => ({
    context: { workspaceId: workspaceContext.workspaceId },
  })),
}));
vi.mock('@/lib/services/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/email')>()),
  sendInvoiceSentEmail: vi.fn().mockResolvedValue({ success: true }),
}));
vi.mock('@/lib/notifications/internal', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from '@wolff/database';
import { getFinancialYear } from '@wolff/core/gst';
import {
  createInvoice,
  createInvoiceFromQuote,
  duplicateInvoice,
  updateInvoice,
} from '@/lib/invoices/actions';
import { createInvoiceFromQuoteInternal } from '@/lib/invoices/internal';
import { getRecurringInvoiceIds } from '@/lib/invoices/recurring';
import { NextRequest } from 'next/server';
import { POST as postInvoice } from '@/app/api/v1/invoices/route';
import { PATCH as patchInvoice } from '@/app/api/v1/invoices/[id]/route';
import { POST as postSendInvoice } from '@/app/api/v1/invoices/[id]/send/route';
import { sendInvoice, updateInvoiceStatus } from '@/lib/invoices/status-actions';

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
  const logo = { name: 'Logo design', quantity: 1, rate: 10000, taxRate: 18, hsnSac: '998311' };
  const gstLines = (id: string) =>
    prisma.invoiceLineItem.findMany({ where: { invoiceId: id }, orderBy: { sortOrder: 'asc' } });
  const FY_NUMBER = /^INV\/\d{2}-\d{2}\/\d{4}$/;

  it('re-prices a GST draft with the engine when its lines are edited', async () => {
    const created = await draft([logo]);

    const result = await updateInvoice(created.invoice!.id, {
      lineItems: [
        { ...logo, rate: 20000 },
        { ...logo, name: 'Brand book', rate: 100.05 },
      ],
    } as never);

    expect(result.success).toBe(true);
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: created.invoice!.id } });
    const lines = await gstLines(invoice.id);
    // 18% on 100.05 is 18.01: CGST 9.01 and SGST 9.00 (the design's rounding).
    expect(lines.map((l) => [Number(l.cgstAmount), Number(l.sgstAmount)])).toEqual([
      [1800, 1800],
      [9.01, 9],
    ]);
    expect(Number(invoice.total)).toBe(23718.06);
    expect((invoice.taxBreakup as { cgstTotal: number }).cgstTotal).toBe(1809.01);
  });

  it('refuses an invoice-level discount on a GST draft', async () => {
    const created = await draft([logo]);

    const result = await updateInvoice(created.invoice!.id, {
      discountType: 'fixed',
      discountValue: 500,
    } as never);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/per line/);
  });

  it('keeps the GST pricing and FY numbering on a duplicate', async () => {
    const created = await draft([logo]);

    const result = await duplicateInvoice(created.invoice!.id);

    const copy = await prisma.invoice.findUniqueOrThrow({ where: { id: result.invoiceId! } });
    expect(copy).toMatchObject({ supplyType: 'intra', placeOfSupply: '33', status: 'draft' });
    expect(copy.invoiceNumber).toMatch(FY_NUMBER);
    expect((await gstLines(copy.id)).map((l) => Number(l.cgstAmount))).toEqual([900]);
  });

  const acceptedQuote = async (hsnSac: string | null) =>
    prisma.quote.create({
      data: {
        workspaceId: workspaceContext.workspaceId,
        clientId,
        quoteNumber: `Q-${randomUUID().slice(0, 8)}`,
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
            hsnSac,
            itemType: 'services',
          },
        },
      },
    });

  it('issues an auto-created invoice (portal, API) priced by the engine', async () => {
    const quote = await acceptedQuote('998311');

    const result = await createInvoiceFromQuoteInternal(quote.id, workspaceContext.workspaceId);

    expect(result.success).toBe(true);
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: result.invoice!.id } });
    expect(invoice).toMatchObject({ status: 'sent', supplyType: 'intra' });
    expect((await gstLines(invoice.id)).map((l) => Number(l.sgstAmount))).toEqual([900]);
  });

  it('leaves an auto-created invoice in draft when Rule 46 fields are missing', async () => {
    const quote = await acceptedQuote(null);

    const result = await createInvoiceFromQuoteInternal(quote.id, workspaceContext.workspaceId);

    expect(result).toMatchObject({ success: true, issued: false });
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: result.invoice!.id } });
    expect(invoice.status).toBe('draft');
  });

  it('lists recurring invoices of the session workspace only, whatever the caller passes', async () => {
    const other = await prisma.workspace.create({
      data: {
        name: 'Other',
        slug: `gst-other-${run}`,
        clients: { create: { name: 'Theirs', email: `theirs-${run}@example.test` } },
      },
      include: { clients: true },
    });
    try {
      const theirs = await prisma.invoice.create({
        data: {
          workspaceId: other.id,
          clientId: other.clients[0]!.id,
          invoiceNumber: `R-${run}`,
          dueDate: new Date('2026-12-01'),
          isRecurring: true,
        },
      });
      // A server action is an endpoint: a browser can call it with any argument.
      const callFromBrowser = getRecurringInvoiceIds as (workspaceId?: string) => Promise<string[]>;

      expect(await callFromBrowser(other.id)).not.toContain(theirs.id);
    } finally {
      await prisma.invoice.deleteMany({ where: { workspaceId: other.id } });
      await prisma.client.deleteMany({ where: { workspaceId: other.id } });
      await prisma.workspace.delete({ where: { id: other.id } });
    }
  });

  describe('legacy /api/v1/invoices', () => {
    const request = (method: string, body: unknown) =>
      new NextRequest('http://localhost/api/v1/invoices', {
        method,
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      });
    const patch = (id: string, body: unknown) =>
      patchInvoice(request('PATCH', body), { params: Promise.resolve({ id }) });

    it('prices a GST invoice created through the API with the engine', async () => {
      const response = await postInvoice(
        request('POST', { clientId, title: 'API', dueDate: '2026-12-01', lineItems: [logo] })
      );

      expect(response.status).toBe(201);
      const { id } = (await response.json()) as { id: string };
      const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id } });
      expect(invoice).toMatchObject({
        supplyType: 'intra',
        invoiceNumber: expect.stringMatching(FY_NUMBER),
      });
      expect((await gstLines(invoice.id)).map((l) => Number(l.cgstAmount))).toEqual([900]);
    });

    it('re-prices GST lines edited through the API', async () => {
      const created = await draft([logo]);

      const response = await patch(created.invoice!.id, { lineItems: [{ ...logo, rate: 20000 }] });

      expect(response.status).toBe(200);
      expect((await gstLines(created.invoice!.id)).map((l) => Number(l.cgstAmount))).toEqual([
        1800,
      ]);
    });

    it('keeps a GST draft that fails Rule 46 from being sent through the API', async () => {
      const created = await draft([{ ...logo, hsnSac: undefined }]);

      const response = await patch(created.invoice!.id, { status: 'sent' });

      expect(response.status).toBe(422);
      const after = await prisma.invoice.findUniqueOrThrow({ where: { id: created.invoice!.id } });
      expect(after.status).toBe('draft');
    });

    const send = (id: string) =>
      postSendInvoice(request('POST', {}), { params: Promise.resolve({ id }) });

    it('sends a complete GST draft through the API send endpoint', async () => {
      const created = await draft([logo]);

      const response = await send(created.invoice!.id);

      expect(response.status).toBe(200);
      const after = await prisma.invoice.findUniqueOrThrow({ where: { id: created.invoice!.id } });
      expect(after.status).toBe('sent');
    });

    it('keeps a GST draft that fails Rule 46 from being issued by the API send endpoint', async () => {
      const created = await draft([{ ...logo, hsnSac: undefined }]);

      const response = await send(created.invoice!.id);

      expect(response.status).toBe(422);
      expect(((await response.json()) as { error: string }).error).toMatch(/HSN/);
      const after = await prisma.invoice.findUniqueOrThrow({ where: { id: created.invoice!.id } });
      expect(after.status).toBe('draft');
      expect(after.sentAt).toBeNull();
    });
  });

  it('refuses a GST invoice whose place of supply cannot be known, instead of assuming IGST', async () => {
    const { workspaceId } = workspaceContext;
    await prisma.businessProfile.update({ where: { workspaceId }, data: { stateCode: null } });
    await prisma.client.update({ where: { id: clientId }, data: { stateCode: null } });
    try {
      const result = await draft([logo]);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/place of supply/);
    } finally {
      await prisma.businessProfile.update({ where: { workspaceId }, data: { stateCode: '33' } });
      await prisma.client.update({ where: { id: clientId }, data: { stateCode: '33' } });
    }
  });
});
