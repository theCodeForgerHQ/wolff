import { Decimal } from 'decimal.js';

export type SupplyType = 'intra' | 'inter' | 'export' | 'sez';

export interface GstLineInput {
  description: string;
  hsnSac?: string;
  itemType: 'goods' | 'services';
  quantity: Decimal | number | string;
  rate: Decimal | number | string;
  discount?: Decimal | number | string;
  gstRate: Decimal | number | string;
}

export interface GstLineOutput {
  description: string;
  hsnSac?: string;
  itemType: 'goods' | 'services';
  quantity: Decimal;
  rate: Decimal;
  discount: Decimal;
  taxableValue: Decimal;
  gstRate: Decimal;
  cgstRate: Decimal;
  cgstAmount: Decimal;
  sgstRate: Decimal;
  sgstAmount: Decimal;
  igstRate: Decimal;
  igstAmount: Decimal;
  cessAmount: Decimal;
  total: Decimal;
}

export interface GstSummaryItem {
  hsnSac?: string;
  gstRate: Decimal;
  taxableValue: Decimal;
  cgstAmount: Decimal;
  sgstAmount: Decimal;
  igstAmount: Decimal;
  cessAmount: Decimal;
  total: Decimal;
}

export interface GstBreakup {
  supplyType: SupplyType;
  subtotal: Decimal;
  discountTotal: Decimal;
  taxableTotal: Decimal;
  cgstTotal: Decimal;
  sgstTotal: Decimal;
  igstTotal: Decimal;
  cessTotal: Decimal;
  taxTotal: Decimal;
  total: Decimal;
  lines: GstLineOutput[];
  hsnSummary: GstSummaryItem[];
}

export interface ComputeGstInput {
  supplierStateCode?: string;
  placeOfSupply?: string;
  isExport?: boolean;
  isSez?: boolean;
  hasLut?: boolean;
  reverseCharge?: boolean;
  lines: GstLineInput[];
}

function toDecimal(value: Decimal | number | string): Decimal {
  if (value instanceof Decimal) return value;
  return new Decimal(value);
}

function round2(value: Decimal): Decimal {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/**
 * Determines the supply type from supplier state, place of supply and flags.
 */
export function determineSupplyType(input: {
  supplierStateCode?: string;
  placeOfSupply?: string;
  isExport?: boolean;
  isSez?: boolean;
}): SupplyType {
  if (input.isExport) return 'export';
  if (input.isSez) return 'sez';
  if (!input.supplierStateCode || !input.placeOfSupply) return 'inter';
  return input.supplierStateCode === input.placeOfSupply ? 'intra' : 'inter';
}

/**
 * Computes GST line items and totals per CBIC Rule 46 rounding rules.
 * - taxableValue = round2(qty * rate - discount)
 * - tax = round2(taxableValue * gstRate / 100)
 * - intra-state: cgst = round2(tax / 2), sgst = tax - cgst
 * - inter-state/export/SEZ: igst = tax
 * - export/SEZ with LUT: igst = 0
 */
export function computeGst(input: ComputeGstInput): GstBreakup {
  const supplyType = determineSupplyType(input);
  const zeroTax = (supplyType === 'export' || supplyType === 'sez') && input.hasLut;

  const lines: GstLineOutput[] = input.lines.map((line) => {
    const quantity = toDecimal(line.quantity);
    const rate = toDecimal(line.rate);
    const discount = round2(toDecimal(line.discount ?? 0));
    const taxableValue = round2(quantity.mul(rate).minus(discount));
    const gstRate = toDecimal(line.gstRate);

    let tax = round2(taxableValue.mul(gstRate).div(100));
    if (zeroTax) {
      tax = new Decimal(0);
    }

    let cgstAmount = new Decimal(0);
    let sgstAmount = new Decimal(0);
    let igstAmount = new Decimal(0);
    let cgstRate = new Decimal(0);
    let sgstRate = new Decimal(0);
    let igstRate = new Decimal(0);

    if (supplyType === 'intra') {
      cgstRate = round2(gstRate.div(2));
      sgstRate = round2(gstRate.minus(cgstRate));
      cgstAmount = round2(tax.div(2));
      sgstAmount = tax.minus(cgstAmount);
      igstRate = new Decimal(0);
    } else {
      igstRate = gstRate;
      igstAmount = tax;
    }

    const total = taxableValue.plus(cgstAmount).plus(sgstAmount).plus(igstAmount);

    return {
      description: line.description,
      hsnSac: line.hsnSac,
      itemType: line.itemType,
      quantity,
      rate,
      discount,
      taxableValue,
      gstRate,
      cgstRate,
      cgstAmount,
      sgstRate,
      sgstAmount,
      igstRate,
      igstAmount,
      cessAmount: new Decimal(0),
      total,
    };
  });

  const hsnMap = new Map<string, GstSummaryItem>();
  for (const line of lines) {
    const key = `${line.hsnSac ?? ''}|${line.gstRate.toString()}`;
    const existing = hsnMap.get(key);
    if (existing) {
      existing.taxableValue = existing.taxableValue.plus(line.taxableValue);
      existing.cgstAmount = existing.cgstAmount.plus(line.cgstAmount);
      existing.sgstAmount = existing.sgstAmount.plus(line.sgstAmount);
      existing.igstAmount = existing.igstAmount.plus(line.igstAmount);
      existing.cessAmount = existing.cessAmount.plus(line.cessAmount);
      existing.total = existing.total.plus(line.total);
    } else {
      hsnMap.set(key, {
        hsnSac: line.hsnSac,
        gstRate: line.gstRate,
        taxableValue: line.taxableValue,
        cgstAmount: line.cgstAmount,
        sgstAmount: line.sgstAmount,
        igstAmount: line.igstAmount,
        cessAmount: line.cessAmount,
        total: line.total,
      });
    }
  }

  const hsnSummary = Array.from(hsnMap.values()).sort((a, b) => a.gstRate.comparedTo(b.gstRate));

  const sum = (key: keyof GstLineOutput) =>
    lines.reduce((acc, line) => acc.plus(line[key] as Decimal), new Decimal(0));

  const subtotal = lines.reduce(
    (acc, line) => acc.plus(line.rate.mul(line.quantity)),
    new Decimal(0)
  );

  return {
    supplyType,
    subtotal,
    discountTotal: sum('discount'),
    taxableTotal: sum('taxableValue'),
    cgstTotal: sum('cgstAmount'),
    sgstTotal: sum('sgstAmount'),
    igstTotal: sum('igstAmount'),
    cessTotal: sum('cessAmount'),
    taxTotal: sum('cgstAmount').plus(sum('sgstAmount')).plus(sum('igstAmount')),
    total: sum('total'),
    lines,
    hsnSummary,
  };
}

// Re-export Decimal for consumers that want to avoid a direct dependency.
export { Decimal };
