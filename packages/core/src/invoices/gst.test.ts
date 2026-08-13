import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrisma, withTenantGuard } from '@wolff/database';
import { CoreError } from '../errors';
import {
  assertGstSupported,
  assertReadyToIssue,
  nextInvoiceNumber,
  priceGstInvoice,
  type GstProfile,
} from './gst';

const profile: GstProfile = {
  businessName: 'Kaveri Studio',
  legalName: 'Kaveri Studio LLP',
  gstin: '33AABCK1234L1Z5',
  stateCode: '33',
  gstRegistrationType: 'regular',
  aggregateTurnoverBand: 'le_5cr',
  lutNumber: null,
  address: { line1: '12 Cathedral Road', city: 'Chennai', postalCode: '600086' },
};

const line = { name: 'Logo design', quantity: 1, rate: 10000, gstRate: 18, hsnSac: '998311' };

describe('priceGstInvoice', () => {
  it('splits CGST/SGST for a client in the same state and snapshots both GSTINs', () => {
    const priced = priceGstInvoice({
      profile,
      client: { gstin: '33AAACR5055K1Z0', stateCode: '33', countryCode: 'IN' },
      lines: [line],
    });

    expect(priced.invoice).toMatchObject({
      supplyType: 'intra',
      placeOfSupply: '33',
      supplierGstin: profile.gstin,
      recipientGstin: '33AAACR5055K1Z0',
      reverseCharge: false,
      subtotal: 10000,
      taxTotal: 1800,
      total: 11800,
    });
    expect(priced.lines[0]).toMatchObject({
      taxableValue: 10000,
      cgstAmount: 900,
      sgstAmount: 900,
      igstAmount: 0,
      amount: 10000,
      taxRate: 18,
      taxAmount: 1800,
    });
  });

  it('charges IGST to a client in another state', () => {
    const priced = priceGstInvoice({
      profile,
      client: { gstin: null, stateCode: '29', countryCode: 'IN' },
      lines: [line],
    });

    expect(priced.invoice).toMatchObject({ supplyType: 'inter', placeOfSupply: '29' });
    expect(priced.lines[0]).toMatchObject({ igstAmount: 1800, cgstAmount: 0 });
  });

  it('shows but does not charge tax under reverse charge', () => {
    const priced = priceGstInvoice({
      profile,
      client: { gstin: '33AAACR5055K1Z0', stateCode: '33', countryCode: 'IN' },
      reverseCharge: true,
      lines: [line],
    });

    expect(priced.invoice).toMatchObject({ reverseCharge: true, taxTotal: 1800, total: 10000 });
  });
});

describe('assertGstSupported', () => {
  it('refuses tax invoices for a composition supplier (they issue a bill of supply)', () => {
    expect(() => assertGstSupported({ ...profile, gstRegistrationType: 'composition' })).toThrow(
      CoreError
    );
    try {
      assertGstSupported({ ...profile, gstRegistrationType: 'composition' });
    } catch (error) {
      expect((error as CoreError).code).toBe('gst_unsupported');
    }
    expect(() => assertGstSupported(profile)).not.toThrow();
  });
});

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('GST invoices in the database', () => {
  const base = createPrisma(url);
  const db = withTenantGuard(base, { mode: 'throw' });
  const run = randomUUID().slice(0, 8);
  const workspaces: string[] = [];

  const gstWorkspace = async (overrides: Record<string, unknown> = {}) => {
    const ws = await base.workspace.create({
      data: {
        name: 'GST invoices',
        slug: `gst-inv-${run}-${workspaces.length}`,
        businessProfile: {
          create: {
            businessName: profile.businessName,
            legalName: profile.legalName,
            gstin: profile.gstin,
            stateCode: '33',
            gstRegistrationType: 'regular',
            currency: 'INR',
            address: profile.address as never,
            ...overrides,
          },
        },
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
    return ws;
  };

  afterAll(async () => {
    await base.invoice.deleteMany({ where: { workspaceId: { in: workspaces } } });
    await base.numberSequence.deleteMany({ where: { workspaceId: { in: workspaces } } });
    await base.client.deleteMany({ where: { workspaceId: { in: workspaces } } });
    await base.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await base.$disconnect();
  });

  it('numbers GST invoices per financial year, changing at midnight IST on 1 April', async () => {
    const ws = await gstWorkspace();
    const lastMinuteOfFy = new Date('2027-03-31T18:29:00Z'); // 31 Mar 23:59 IST
    const firstMinuteOfFy = new Date('2027-03-31T18:30:00Z'); // 1 Apr 00:00 IST

    const a = await nextInvoiceNumber(db, ws.id, lastMinuteOfFy);
    const b = await nextInvoiceNumber(db, ws.id, lastMinuteOfFy);
    const c = await nextInvoiceNumber(db, ws.id, firstMinuteOfFy);

    // The FY is part of the number: invoice numbers are unique per
    // workspace, so a number reused in the next FY could not be stored.
    expect([a, b, c]).toEqual(['INV/26-27/0001', 'INV/26-27/0002', 'INV/27-28/0001']);
    for (const [invoiceNumber, issueDate] of [
      [a, lastMinuteOfFy],
      [b, lastMinuteOfFy],
      [c, firstMinuteOfFy],
    ] as const) {
      await base.invoice.create({
        data: {
          workspaceId: ws.id,
          clientId: ws.clients[0]!.id,
          invoiceNumber,
          issueDate,
          dueDate: issueDate,
          total: 0,
          amountDue: 0,
        },
      });
    }
    const years = await base.numberSequence.findMany({
      where: { workspaceId: ws.id },
      select: { financialYear: true, currentValue: true },
      orderBy: { financialYear: 'asc' },
    });
    expect(years).toEqual([
      { financialYear: '2026-27', currentValue: 2 },
      { financialYear: '2027-28', currentValue: 1 },
    ]);
  });

  const draftInvoice = async (
    ws: { id: string; clients: { id: string }[] },
    lineData: Record<string, unknown> = {}
  ) =>
    base.invoice.create({
      data: {
        workspaceId: ws.id,
        clientId: ws.clients[0]!.id,
        invoiceNumber: `INV-${randomUUID().slice(0, 4)}`,
        status: 'draft',
        dueDate: new Date('2026-12-01'),
        total: 11800,
        amountDue: 11800,
        currency: 'INR',
        placeOfSupply: '33',
        supplyType: 'intra',
        supplierGstin: profile.gstin,
        recipientGstin: '33AAACR5055K1Z0',
        lineItems: {
          create: {
            name: 'Logo design',
            quantity: 1,
            rate: 10000,
            amount: 10000,
            hsnSac: '998311',
            itemType: 'services',
            gstRate: 18,
            taxableValue: 10000,
            cgstAmount: 900,
            sgstAmount: 900,
            ...lineData,
          },
        },
      },
    });

  it('lets a complete GST invoice leave draft', async () => {
    const ws = await gstWorkspace();
    const invoice = await draftInvoice(ws);

    await expect(assertReadyToIssue(db, ws.id, invoice.id)).resolves.toBeUndefined();
  });

  it('keeps a GST invoice in draft while Rule 46 fields are missing, and says which', async () => {
    const ws = await gstWorkspace();
    const invoice = await draftInvoice(ws, { hsnSac: null });

    const error = await assertReadyToIssue(db, ws.id, invoice.id).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CoreError);
    expect((error as CoreError).code).toBe('business_rule');
    expect((error as CoreError).details?.rule46).toEqual(
      expect.arrayContaining([expect.stringContaining('HSN')])
    );
  });

  it('refuses to issue for a composition supplier', async () => {
    const ws = await gstWorkspace({ gstRegistrationType: 'composition' });
    const invoice = await draftInvoice(ws);

    const error = await assertReadyToIssue(db, ws.id, invoice.id).catch((e: unknown) => e);

    expect((error as CoreError).code).toBe('gst_unsupported');
  });
});
