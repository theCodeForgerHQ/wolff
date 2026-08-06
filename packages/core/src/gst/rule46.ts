import type { Decimal } from 'decimal.js';

export interface Rule46Line {
  description: string;
  hsnSac?: string;
  quantity: Decimal | number | string;
  unit?: string;
  taxableValue: Decimal | number | string;
  cgstRate?: Decimal | number | string;
  cgstAmount: Decimal | number | string;
  sgstRate?: Decimal | number | string;
  sgstAmount: Decimal | number | string;
  igstRate?: Decimal | number | string;
  igstAmount: Decimal | number | string;
}

export interface Rule46Invoice {
  isGstInvoice: boolean;
  supplierName?: string;
  supplierAddress?: string;
  supplierGstin?: string;
  serialNumber: string;
  issueDate: Date;
  recipientName?: string;
  recipientAddress?: string;
  recipientGstin?: string;
  placeOfSupply?: string;
  reverseCharge: boolean;
  signature?: string;
  aggregateTurnoverBand?: 'le_5cr' | 'gt_5cr';
  /** True when the supply crosses state lines (including SEZ / export). */
  isInterState?: boolean;
  lines: Rule46Line[];
}

export interface Rule46Violation {
  code: string;
  message: string;
}

function toNum(value: Decimal | number | string): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  return value.toNumber();
}

/**
 * Validates the mandatory fields required by Rule 46 before an invoice can
 * leave draft. Returns a list of violations; an empty list means the invoice
 * is valid.
 */
export function validateRule46(invoice: Rule46Invoice): Rule46Violation[] {
  const violations: Rule46Violation[] = [];

  if (!invoice.isGstInvoice) return violations;

  if (!invoice.supplierName)
    violations.push({ code: 'supplier_name', message: 'Supplier name is required' });
  if (!invoice.supplierAddress)
    violations.push({ code: 'supplier_address', message: 'Supplier address is required' });
  if (!invoice.supplierGstin)
    violations.push({ code: 'supplier_gstin', message: 'Supplier GSTIN is required' });
  if (!invoice.serialNumber)
    violations.push({ code: 'serial_number', message: 'Serial number is required' });
  if (invoice.serialNumber.length > 16) {
    violations.push({
      code: 'serial_number_length',
      message: 'Serial number must be ≤ 16 characters',
    });
  }
  if (!invoice.issueDate)
    violations.push({ code: 'issue_date', message: 'Issue date is required' });

  const registeredRecipient = Boolean(invoice.recipientGstin);
  if (registeredRecipient && !invoice.recipientGstin) {
    violations.push({
      code: 'recipient_gstin',
      message: 'Recipient GSTIN is required for registered recipients',
    });
  }

  const totalTaxable = invoice.lines.reduce((sum, line) => sum + toNum(line.taxableValue), 0);
  const unregisteredOver50k = !registeredRecipient && totalTaxable > 50_000;
  const needsPlaceOfSupply = invoice.isInterState || unregisteredOver50k;
  if (unregisteredOver50k && !invoice.recipientAddress) {
    violations.push({
      code: 'recipient_address',
      message: 'Recipient address is required for unregistered B2C > ₹50,000',
    });
  }
  if (needsPlaceOfSupply && !invoice.placeOfSupply) {
    violations.push({
      code: 'place_of_supply',
      message:
        'Place of supply is required for inter-state / export / SEZ or unregistered B2C > ₹50,000',
    });
  }

  if (invoice.lines.length === 0) {
    violations.push({ code: 'lines', message: 'At least one line item is required' });
  }

  for (const line of invoice.lines) {
    if (!line.description)
      violations.push({ code: 'line_description', message: 'Line description is required' });
    if (!line.hsnSac) violations.push({ code: 'line_hsn', message: 'HSN/SAC is required' });
    if (line.hsnSac && !isValidHsnDigits(line.hsnSac, invoice.aggregateTurnoverBand)) {
      violations.push({
        code: 'line_hsn_digits',
        message: 'HSN/SAC digit count is invalid for turnover band',
      });
    }
    if (toNum(line.quantity) <= 0)
      violations.push({ code: 'line_quantity', message: 'Line quantity must be positive' });
    if (!line.unit) violations.push({ code: 'line_unit', message: 'Line unit is required' });
    if (toNum(line.taxableValue) < 0)
      violations.push({
        code: 'line_taxable_value',
        message: 'Line taxable value cannot be negative',
      });

    const hasIntraTax = toNum(line.cgstAmount) > 0 || toNum(line.sgstAmount) > 0;
    const hasInterTax = toNum(line.igstAmount) > 0;
    if (!hasIntraTax && !hasInterTax) {
      violations.push({ code: 'line_tax', message: 'Line must have CGST/SGST or IGST' });
    }
  }

  if (!invoice.signature) violations.push({ code: 'signature', message: 'Signature is required' });

  return violations;
}

function isValidHsnDigits(hsnSac: string, band?: 'le_5cr' | 'gt_5cr'): boolean {
  const digits = hsnSac.replace(/\D/g, '').length;
  if (band === 'gt_5cr') return digits === 6;
  return digits === 4 || digits === 6;
}
