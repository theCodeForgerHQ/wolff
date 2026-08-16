import { incrementNumberSequence, type Prisma } from '@wolff/database';
import type { Db, DbOrTx } from '../context';
import { CoreError } from '../errors';
import { computeGst, type GstLineInput } from '../gst/engine';
import { nextSerialNumber } from '../gst/numbering';
import { validateRule46, type Rule46Invoice } from '../gst/rule46';

/**
 * GST on invoices, for workspaces whose business profile has a
 * GSTIN. A workspace without one keeps the generic tax behaviour and its
 * numbering; nothing here changes it.
 *
 * - Prices are computed by the engine (per-line rounding, CGST/SGST split,
 *   IGST, LUT, reverse charge) and stored on the invoice and its lines.
 * - Numbers come from a sequence per financial year (Asia/Kolkata), at most
 *   16 characters.
 * - An invoice may leave draft only when Rule 46's mandatory fields are
 *   present. Composition suppliers are refused (`gst_unsupported`): they
 *   must issue a bill of supply, which this product does not produce.
 */

export interface GstProfile {
  businessName: string;
  legalName: string | null;
  gstin: string | null;
  stateCode: string | null;
  gstRegistrationType: 'regular' | 'composition' | 'unregistered' | 'overseas';
  aggregateTurnoverBand: 'le_5cr' | 'gt_5cr';
  lutNumber: string | null;
  address: unknown;
}

export interface GstClient {
  gstin: string | null;
  stateCode: string | null;
  countryCode: string | null;
}

export interface GstInvoiceLineInput {
  name: string;
  description?: string | null;
  quantity: number;
  rate: number;
  gstRate: number;
  hsnSac?: string | null;
  itemType?: 'goods' | 'services';
  discount?: number;
}

/** GST state code used on the place of supply of an export ("Other Country"). */
const EXPORT_PLACE_OF_SUPPLY = '96';

export async function loadGstProfile(db: DbOrTx, workspaceId: string): Promise<GstProfile | null> {
  return db.businessProfile.findFirst({
    where: { workspaceId },
    select: {
      businessName: true,
      legalName: true,
      gstin: true,
      stateCode: true,
      gstRegistrationType: true,
      aggregateTurnoverBand: true,
      lutNumber: true,
      address: true,
    },
  });
}

export function isGstWorkspace(profile: GstProfile | null): profile is GstProfile {
  return Boolean(profile?.gstin);
}

export function assertGstSupported(profile: GstProfile): void {
  if (profile.gstRegistrationType === 'composition') {
    throw new CoreError(
      'gst_unsupported',
      'Composition suppliers issue a bill of supply, not a tax invoice, and this product cannot issue one'
    );
  }
}

/**
 * Prices an invoice under GST. Returns the invoice and line fields to store.
 * `amount` on a line is its taxable value and `taxRate`/`taxAmount` mirror
 * the GST rate and tax, so screens that only know the generic fields still
 * show the right numbers.
 */
export function priceGstInvoice(input: {
  profile: GstProfile;
  client: GstClient;
  lines: GstInvoiceLineInput[];
  placeOfSupply?: string | null;
  reverseCharge?: boolean;
}) {
  const { profile, client } = input;
  const isExport = Boolean(client.countryCode && client.countryCode !== 'IN');
  const placeOfSupply =
    input.placeOfSupply ??
    (isExport ? EXPORT_PLACE_OF_SUPPLY : (client.stateCode ?? profile.stateCode ?? undefined));

  const lines: GstLineInput[] = input.lines.map((line) => ({
    description: line.name,
    hsnSac: line.hsnSac ?? undefined,
    itemType: line.itemType ?? 'services',
    quantity: line.quantity,
    rate: line.rate,
    discount: line.discount ?? 0,
    gstRate: line.gstRate,
  }));
  const breakup = computeGst({
    supplierStateCode: profile.stateCode ?? undefined,
    placeOfSupply: placeOfSupply ?? undefined,
    isExport,
    hasLut: Boolean(profile.lutNumber),
    reverseCharge: input.reverseCharge ?? false,
    lines,
  });

  const n = (value: { toNumber(): number }) => value.toNumber();
  return {
    invoice: {
      placeOfSupply: placeOfSupply ?? null,
      supplyType: breakup.supplyType,
      reverseCharge: input.reverseCharge ?? false,
      supplierGstin: profile.gstin,
      recipientGstin: client.gstin,
      subtotal: n(breakup.taxableTotal),
      taxTotal: n(breakup.taxTotal),
      total: n(breakup.total),
      taxBreakup: {
        supplyType: breakup.supplyType,
        taxableTotal: n(breakup.taxableTotal),
        cgstTotal: n(breakup.cgstTotal),
        sgstTotal: n(breakup.sgstTotal),
        igstTotal: n(breakup.igstTotal),
        cessTotal: n(breakup.cessTotal),
        taxTotal: n(breakup.taxTotal),
        taxPayableByRecipient: n(breakup.taxPayableByRecipient),
        total: n(breakup.total),
        hsnSummary: breakup.hsnSummary.map((row) => ({
          hsnSac: row.hsnSac ?? null,
          gstRate: n(row.gstRate),
          taxableValue: n(row.taxableValue),
          cgstAmount: n(row.cgstAmount),
          sgstAmount: n(row.sgstAmount),
          igstAmount: n(row.igstAmount),
        })),
      },
    },
    lines: breakup.lines.map((line, index) => {
      const source = input.lines[index]!;
      const tax = line.cgstAmount.plus(line.sgstAmount).plus(line.igstAmount);
      return {
        name: source.name,
        description: source.description ?? null,
        quantity: n(line.quantity),
        rate: n(line.rate),
        amount: n(line.taxableValue),
        taxRate: n(line.gstRate),
        taxAmount: n(tax),
        hsnSac: line.hsnSac ?? null,
        itemType: line.itemType,
        gstRate: n(line.gstRate),
        taxableValue: n(line.taxableValue),
        cgstRate: n(line.cgstRate),
        cgstAmount: n(line.cgstAmount),
        sgstRate: n(line.sgstRate),
        sgstAmount: n(line.sgstAmount),
        igstRate: n(line.igstRate),
        igstAmount: n(line.igstAmount),
        cessAmount: 0,
        sortOrder: index,
      };
    }),
  };
}

export type PricedGstInvoice = ReturnType<typeof priceGstInvoice>;

type Numeric = number | { toString(): string };

/** A stored quote or invoice line, with the fields the GST engine reads. */
export interface StoredGstLine {
  name: string;
  description: string | null;
  quantity: Numeric;
  rate: Numeric;
  gstRate: Numeric | null;
  taxRate: Numeric | null;
  hsnSac: string | null;
  itemType: 'goods' | 'services';
}

/** Stored lines as engine input; the GST rate falls back to the generic rate. */
export function gstLinesFrom(lines: StoredGstLine[]): GstInvoiceLineInput[] {
  return lines.map((line) => ({
    name: line.name,
    description: line.description,
    quantity: Number(line.quantity),
    rate: Number(line.rate),
    gstRate: Number(line.gstRate ?? line.taxRate ?? 0),
    hsnSac: line.hsnSac,
    itemType: line.itemType,
  }));
}

/**
 * Prices an invoice for whichever workspace it belongs to: null for a
 * workspace without a GSTIN (the caller keeps its generic totals), the
 * engine's result otherwise. Every path that writes invoice amounts calls
 * this, so a GST workspace never gets generic totals.
 *
 * Throws `gst_unsupported` for a composition supplier and `business_rule`
 * for an invoice-level discount: GST discounts are per line, before tax.
 */
export async function priceForWorkspace(
  db: DbOrTx,
  workspaceId: string,
  input: {
    client: GstClient;
    lines: GstInvoiceLineInput[];
    discountAmount?: number;
    placeOfSupply?: string | null;
    reverseCharge?: boolean;
  }
): Promise<PricedGstInvoice | null> {
  const profile = await loadGstProfile(db, workspaceId);
  if (!isGstWorkspace(profile)) return null;
  assertGstSupported(profile);
  if ((input.discountAmount ?? 0) > 0) {
    throw new CoreError(
      'business_rule',
      'GST invoices take discounts per line, before tax; remove the invoice discount'
    );
  }
  return priceGstInvoice({
    profile,
    client: input.client,
    lines: input.lines,
    placeOfSupply: input.placeOfSupply ?? null,
    reverseCharge: input.reverseCharge ?? false,
  });
}

/** The invoice columns a GST price sets (amountDue is left to the caller). */
export function gstInvoiceColumns(priced: PricedGstInvoice) {
  return {
    subtotal: priced.invoice.subtotal,
    taxTotal: priced.invoice.taxTotal,
    total: priced.invoice.total,
    discountType: null,
    discountValue: null,
    discountAmount: 0,
    placeOfSupply: priced.invoice.placeOfSupply,
    supplyType: priced.invoice.supplyType,
    reverseCharge: priced.invoice.reverseCharge,
    supplierGstin: priced.invoice.supplierGstin,
    recipientGstin: priced.invoice.recipientGstin,
    taxBreakup: priced.invoice.taxBreakup as Prisma.InputJsonValue,
  };
}

/**
 * The next invoice number. A GST workspace numbers per financial year of the
 * issue date (Rule 46(b): unique for the financial year, ≤ 16 characters);
 * any other workspace keeps its single running sequence and stored prefix.
 */
export function nextInvoiceNumber(
  db: Db,
  workspaceId: string,
  issueDate: Date = new Date()
): Promise<string> {
  return nextDocumentNumber(db, workspaceId, { type: 'invoice', prefix: 'INV' }, issueDate);
}

/**
 * The next credit note number, counted like an invoice's: per financial
 * year in a GST workspace ("CN/26-27/0001"), one running "CN-0001" sequence
 * otherwise.
 */
export function nextCreditNoteNumber(
  db: Db,
  workspaceId: string,
  date: Date = new Date()
): Promise<string> {
  return nextDocumentNumber(db, workspaceId, { type: 'credit_note', prefix: 'CN' }, date);
}

async function nextDocumentNumber(
  db: Db,
  workspaceId: string,
  document: { type: string; prefix: string },
  date: Date
): Promise<string> {
  const profile = await loadGstProfile(db, workspaceId);
  if (isGstWorkspace(profile)) {
    try {
      const { serialNumber } = await nextSerialNumber(db, {
        workspaceId,
        type: document.type,
        prefix: document.prefix,
        date,
      });
      return serialNumber;
    } catch (error) {
      throw new CoreError(
        'business_rule',
        error instanceof Error ? error.message : `Could not number this GST ${document.type}`
      );
    }
  }

  const sequence = await db.$transaction((tx) =>
    incrementNumberSequence(
      tx as unknown as Parameters<typeof incrementNumberSequence>[0],
      workspaceId,
      document.type,
      null,
      { prefix: document.prefix, currentValue: 1, padding: 4 }
    )
  );
  const parts = [
    (sequence.prefix || document.prefix).replace(/-$/, ''),
    String(sequence.currentValue).padStart(sequence.padding, '0'),
  ];
  if (sequence.suffix) parts.push(sequence.suffix);
  return parts.join('-');
}

function formatAddress(address: unknown): string | undefined {
  if (!address || typeof address !== 'object') return undefined;
  const parts = Object.values(address as Record<string, unknown>).filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0
  );
  return parts.length > 0 ? parts.join(', ') : undefined;
}

/**
 * Throws unless the invoice may leave draft. A no-op for workspaces without
 * a GSTIN.
 */
export async function assertReadyToIssue(
  db: DbOrTx,
  workspaceId: string,
  invoiceId: string
): Promise<void> {
  const profile = await loadGstProfile(db, workspaceId);
  if (!isGstWorkspace(profile)) return;
  assertGstSupported(profile);

  const invoice = await db.invoice.findFirst({
    where: { id: invoiceId, workspaceId },
    include: {
      client: true,
      lineItems: { where: { invoice: { workspaceId } }, orderBy: { sortOrder: 'asc' } },
    },
  });
  if (!invoice) throw new CoreError('not_found', 'Invoice not found');

  const zeroRated =
    (invoice.supplyType === 'export' || invoice.supplyType === 'sez') && Boolean(profile.lutNumber);
  const rule46: Rule46Invoice = {
    isGstInvoice: true,
    supplierName: profile.legalName ?? profile.businessName,
    supplierAddress: formatAddress(profile.address),
    supplierGstin: invoice.supplierGstin ?? profile.gstin ?? undefined,
    serialNumber: invoice.invoiceNumber,
    issueDate: invoice.issueDate,
    recipientName: invoice.client.name,
    recipientAddress: formatAddress(invoice.client.billingAddress ?? invoice.client.address),
    recipientGstin: invoice.recipientGstin ?? invoice.client.gstin ?? undefined,
    placeOfSupply: invoice.placeOfSupply ?? undefined,
    reverseCharge: invoice.reverseCharge,
    // Invoices are issued electronically. Rule 46(q)'s proviso waives the
    // signature for an electronic invoice under the IT Act, 2000; this
    // reading is recorded for the owner's CA to confirm (docs/phase-4.md).
    signature: 'electronic',
    aggregateTurnoverBand: profile.aggregateTurnoverBand,
    isInterState: invoice.supplyType !== 'intra',
    zeroRated,
    lines: invoice.lineItems.map((line) => ({
      description: line.name,
      itemType: line.itemType,
      hsnSac: line.hsnSac ?? undefined,
      quantity: line.quantity.toString(),
      // No unit is stored yet, so a goods line cannot pass (see Rule46Line).
      unit: undefined,
      taxableValue: line.taxableValue.toString(),
      cgstAmount: line.cgstAmount.toString(),
      sgstAmount: line.sgstAmount.toString(),
      igstAmount: line.igstAmount.toString(),
    })),
  };

  const violations = validateRule46(rule46);
  if (violations.length > 0) {
    throw new CoreError('business_rule', 'This GST invoice is missing details Rule 46 requires', {
      rule46: violations.map((v) => v.message),
    });
  }
}
