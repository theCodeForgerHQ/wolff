import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createPrisma, withTenantGuard } from '@wolff/database';
import { CoreError } from '../errors';
import { createInvoiceFromQuote, describeCoreError } from './from-quote';

const url = process.env.TEST_DATABASE_URL;

describe('describeCoreError', () => {
  it('appends every reason to the message', () => {
    const error = new CoreError('business_rule', 'Rule 46', {
      rule46: ['GSTIN missing', 'HSN missing'],
      other: ['x'],
    });
    expect(describeCoreError(error)).toBe('Rule 46: GSTIN missing; HSN missing; x');
  });

  it('gives the message alone when there are no reasons', () => {
    expect(describeCoreError(new CoreError('not_found', 'Gone'))).toBe('Gone');
    expect(describeCoreError(new CoreError('not_found', 'Gone', { a: [] }))).toBe('Gone');
  });
});

describe.skipIf(!url)('createInvoiceFromQuote (Postgres)', () => {
  const base = createPrisma(url);
  const db = withTenantGuard(base, { mode: 'throw' });
  const run = randomUUID().slice(0, 8);
  const workspaces: string[] = [];

  const GST_PROFILE = {
    businessName: 'Kaveri Studio',
    legalName: 'Kaveri Studio LLP',
    gstin: '33AABCK1234L1Z5',
    stateCode: '33',
    gstRegistrationType: 'regular' as const,
    currency: 'INR',
    address: { line1: '12 Cathedral Road', city: 'Chennai', postalCode: '600086' },
  };

  async function workspace(profile?: Record<string, unknown>) {
    const ws = await base.workspace.create({
      data: {
        name: 'From quote',
        slug: `from-quote-${run}-${workspaces.length}`,
        ...(profile && { businessProfile: { create: profile as never } }),
        clients: {
          create: {
            name: 'Ravi Textiles',
            email: `ravi-${run}-${workspaces.length}@example.test`,
            gstin: '33AAACR5055K1Z0',
            stateCode: '33',
            isGstRegistered: true,
            address: { line1: '4 Mount Road', city: 'Chennai' },
          },
        },
      },
      include: { clients: true },
    });
    workspaces.push(ws.id);
    return { workspaceId: ws.id, clientId: ws.clients[0]!.id };
  }

  async function quote(
    ws: { workspaceId: string; clientId: string },
    lines: { hsnSac?: string | null; gstRate?: number }[] = [{}],
    extra: Record<string, unknown> = {}
  ) {
    const q = await base.quote.create({
      data: {
        workspaceId: ws.workspaceId,
        clientId: ws.clientId,
        quoteNumber: `FQ-${randomUUID().slice(0, 8)}`,
        title: 'Brand refresh',
        status: 'accepted',
        subtotal: 10_000,
        taxTotal: 1_800,
        total: 11_800,
        notes: 'Thanks',
        ...extra,
        lineItems: {
          create: lines.map((line, i) => ({
            name: `Line ${i}`,
            quantity: 1,
            rate: 10_000,
            amount: 10_000,
            taxRate: 18,
            taxAmount: 1_800,
            sortOrder: i,
            hsnSac: line.hsnSac === undefined ? '998311' : line.hsnSac,
            gstRate: line.gstRate ?? 18,
          })),
        },
      },
    });
    return q.id;
  }

  const load = (invoiceId: string) =>
    base.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      include: { lineItems: { orderBy: { sortOrder: 'asc' } }, events: true },
    });
  const renders = (invoiceId: string) =>
    base.outboxEvent.count({ where: { type: 'pdf.render', aggregateId: invoiceId } });

  afterAll(async () => {
    await base.outboxEvent.deleteMany({ where: { workspaceId: { in: workspaces } } });
    await base.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await base.$disconnect();
  });

  it('issues the invoice of a non-GST quote with its totals and lines, once', async () => {
    const ws = await workspace();
    const quoteId = await quote(ws, [{}, {}]);

    const before = Date.now();
    const result = await createInvoiceFromQuote(db, ws.workspaceId, quoteId, { dueDays: 7 });

    expect(result).toMatchObject({ success: true, issued: true });
    const invoice = await load(result.invoice!.id);
    expect(invoice).toMatchObject({
      status: 'sent',
      quoteId,
      title: 'Brand refresh',
      notes: 'Thanks',
    });
    expect(Number(invoice.total)).toBe(11_800);
    expect(Number(invoice.amountDue)).toBe(11_800);
    expect(invoice.lineItems.map((l) => [l.name, l.sortOrder])).toEqual([
      ['Line 0', 0],
      ['Line 1', 1],
    ]);
    expect(invoice.accessToken).toMatch(/^[0-9a-f]{64}$/);
    expect(invoice.accessToken).toBe(result.invoice!.accessToken);
    // A date column: compare calendar dates.
    const due = new Date(before);
    due.setDate(due.getDate() + 7);
    expect(invoice.dueDate.toISOString().slice(0, 10)).toBe(due.toISOString().slice(0, 10));
    expect(invoice.events.map((e) => e.eventType)).toEqual(['created']);
    expect(await renders(invoice.id)).toBe(1);
    const q = await base.quote.findUniqueOrThrow({
      where: { id: quoteId },
      include: { events: true },
    });
    expect(q.status).toBe('converted');
    expect(q.events.map((e) => e.eventType)).toEqual(['converted_to_invoice']);

    expect(await createInvoiceFromQuote(db, ws.workspaceId, quoteId)).toEqual({
      success: false,
      error: 'Invoice already exists for this quote',
    });
    expect(await base.invoice.count({ where: { quoteId } })).toBe(1);
  });

  it('answers a concurrent second conversion with a conflict and burns no number', async () => {
    const ws = await workspace();
    const quoteId = await quote(ws);

    const results = await Promise.all([
      createInvoiceFromQuote(db, ws.workspaceId, quoteId),
      createInvoiceFromQuote(db, ws.workspaceId, quoteId),
    ]);

    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(results.filter((r) => !r.success)).toEqual([
      { success: false, error: 'Invoice already exists for this quote' },
    ]);
    // The loser's number was rolled back with its insert: the series stays
    // consecutive (GST Rule 46 wants a consecutive serial).
    const next = await createInvoiceFromQuote(db, ws.workspaceId, await quote(ws));
    const numbers = (
      await base.invoice.findMany({
        where: { workspaceId: ws.workspaceId },
        orderBy: { invoiceNumber: 'asc' },
      })
    ).map((i) => i.invoiceNumber);
    expect(next.success).toBe(true);
    expect(numbers).toEqual(['INV-0001', 'INV-0002']);
  });

  it("refuses another workspace's quote and a deleted one", async () => {
    const a = await workspace();
    const b = await workspace();
    const theirs = await quote(b);
    const deleted = await quote(a, [{}], { deletedAt: new Date() });

    for (const id of [theirs, deleted]) {
      expect(await createInvoiceFromQuote(db, a.workspaceId, id)).toEqual({
        success: false,
        error: 'Quote not found',
      });
    }
    expect(await base.invoice.count({ where: { quoteId: { in: [theirs, deleted] } } })).toBe(0);
  });

  it('prices a GST quote with the GST engine and issues it when Rule 46 passes', async () => {
    const ws = await workspace(GST_PROFILE);
    const quoteId = await quote(ws);

    const result = await createInvoiceFromQuote(db, ws.workspaceId, quoteId);

    expect(result).toMatchObject({ success: true, issued: true });
    const invoice = await load(result.invoice!.id);
    expect(invoice.status).toBe('sent');
    expect(invoice.sentAt).not.toBeNull();
    // Intra-state (33 to 33): 18% split into CGST and SGST on the line.
    expect(invoice.supplyType).toBe('intra');
    expect(invoice.supplierGstin).toBe(GST_PROFILE.gstin);
    expect(Number(invoice.taxTotal)).toBe(1_800);
    expect(invoice.lineItems.map((l) => [Number(l.cgstAmount), Number(l.sgstAmount)])).toEqual([
      [900, 900],
    ]);
    expect(Number(invoice.total)).toBe(11_800);
    expect(await renders(invoice.id)).toBe(1);
  });

  it('leaves a GST invoice in draft, says why, and renders nothing when Rule 46 fails', async () => {
    const ws = await workspace(GST_PROFILE);
    const quoteId = await quote(ws, [{ hsnSac: null }]);

    const result = await createInvoiceFromQuote(db, ws.workspaceId, quoteId);

    expect(result).toMatchObject({ success: true, issued: false });
    const invoice = await load(result.invoice!.id);
    expect(invoice.status).toBe('draft');
    expect(invoice.sentAt).toBeNull();
    const blocked = invoice.events.find((e) => e.eventType === 'auto_send_blocked');
    expect(blocked?.metadata).toMatchObject({ details: { rule46: expect.any(Array) } });
    expect(await renders(invoice.id)).toBe(0);
  });

  it('refuses a GST quote with an invoice-level discount and creates nothing', async () => {
    const ws = await workspace(GST_PROFILE);
    const quoteId = await quote(ws, [{}], { discountAmount: 500 });

    const result = await createInvoiceFromQuote(db, ws.workspaceId, quoteId);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/discount/);
    expect(await base.invoice.count({ where: { quoteId } })).toBe(0);
    expect((await base.quote.findUniqueOrThrow({ where: { id: quoteId } })).status).toBe(
      'accepted'
    );
  });

  it('refuses a GST quote whose client has no state code instead of charging CGST+SGST', async () => {
    const ws = await workspace(GST_PROFILE);
    await base.client.update({ where: { id: ws.clientId }, data: { stateCode: null } });
    const quoteId = await quote(ws);

    const result = await createInvoiceFromQuote(db, ws.workspaceId, quoteId);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/client state code/);
    expect(await base.invoice.count({ where: { quoteId } })).toBe(0);
    expect((await base.quote.findUniqueOrThrow({ where: { id: quoteId } })).status).toBe(
      'accepted'
    );
  });

  it('refuses a composition supplier', async () => {
    const ws = await workspace({ ...GST_PROFILE, gstRegistrationType: 'composition' });
    const quoteId = await quote(ws);

    const result = await createInvoiceFromQuote(db, ws.workspaceId, quoteId);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Composition/);
  });
});
