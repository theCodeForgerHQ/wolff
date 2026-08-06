import { describe, expect, it } from 'vitest';
import { validateRule46 } from './rule46';

function validInvoice(): import('./rule46').Rule46Invoice {
  return {
    isGstInvoice: true,
    supplierName: 'GST Co',
    supplierAddress: 'Chennai',
    supplierGstin: '33AABCU9603R1ZX',
    serialNumber: 'INV-0001',
    issueDate: new Date(),
    recipientName: 'Client',
    recipientAddress: 'Bangalore',
    recipientGstin: '29AABCU9603R1ZX',
    placeOfSupply: '29',
    reverseCharge: false,
    signature: 'signed',
    aggregateTurnoverBand: 'le_5cr',
    isInterState: true,
    lines: [
      {
        description: 'Design',
        hsnSac: '9983',
        quantity: 1,
        unit: 'job',
        taxableValue: 10000,
        cgstRate: 9,
        cgstAmount: 900,
        sgstRate: 9,
        sgstAmount: 900,
        igstRate: 0,
        igstAmount: 0,
      },
    ],
  };
}

describe('Rule 46 validation', () => {
  it('passes a valid invoice', () => {
    expect(validateRule46(validInvoice())).toHaveLength(0);
  });

  it('requires supplier details', () => {
    const invoice = validInvoice();
    invoice.supplierGstin = '';
    const violations = validateRule46(invoice);
    expect(violations.some((v) => v.code === 'supplier_gstin')).toBe(true);
  });

  it('rejects serial numbers over 16 characters', () => {
    const invoice = validInvoice();
    invoice.serialNumber = 'INV-123456789012345';
    const violations = validateRule46(invoice);
    expect(violations.some((v) => v.code === 'serial_number_length')).toBe(true);
  });

  it('requires address and place of supply for unregistered B2C > 50k', () => {
    const invoice = validInvoice();
    invoice.recipientGstin = '';
    invoice.isInterState = false;
    invoice.lines[0]!.taxableValue = 60_000;
    invoice.recipientAddress = '';
    invoice.placeOfSupply = '';
    const violations = validateRule46(invoice);
    expect(violations.some((v) => v.code === 'recipient_address')).toBe(true);
    expect(violations.some((v) => v.code === 'place_of_supply')).toBe(true);
  });

  it('validates HSN digit count by turnover band', () => {
    const invoice = validInvoice();
    invoice.aggregateTurnoverBand = 'gt_5cr';
    invoice.lines[0]!.hsnSac = '9983';
    const violations = validateRule46(invoice);
    expect(violations.some((v) => v.code === 'line_hsn_digits')).toBe(true);
  });

  it('skips validation for non-GST invoices', () => {
    const invoice = validInvoice();
    invoice.isGstInvoice = false;
    invoice.supplierGstin = '';
    expect(validateRule46(invoice)).toHaveLength(0);
  });

  it('does not require place of supply for intra-state B2B registered invoices', () => {
    const invoice = validInvoice();
    invoice.isInterState = false;
    invoice.placeOfSupply = '';
    invoice.recipientGstin = '29AABCU9603R1ZX';
    invoice.lines[0]!.taxableValue = 10_000;
    const violations = validateRule46(invoice);
    expect(violations.some((v) => v.code === 'place_of_supply')).toBe(false);
  });
});
