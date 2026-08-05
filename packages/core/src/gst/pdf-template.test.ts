import { describe, expect, it } from 'vitest';
import { renderGstInvoiceHtml, type GstInvoiceLineItem } from './pdf-template';

describe('renderGstInvoiceHtml', () => {
  const baseInvoice = {
    invoiceNumber: 'INV-001',
    issueDate: new Date('2026-10-01'),
    dueDate: new Date('2026-10-15'),
    supplierName: 'Kaveri Studio',
    supplierAddress: 'Chennai, Tamil Nadu',
    supplierGstin: '33AABCU9603R1ZX',
    recipientName: 'Acme Corp',
    recipientAddress: 'Bangalore, Karnataka',
    recipientGstin: '29AABCU9603R1ZX',
    placeOfSupply: '29',
    supplyType: 'regular',
    reverseCharge: false,
    currency: 'INR',
    subtotal: 1000,
    taxTotal: 180,
    total: 1180,
    amountPaid: 0,
    amountDue: 1180,
    lineItems: [
      {
        name: 'Brand Design',
        description: 'Logo and identity',
        quantity: 1,
        rate: 1000,
        amount: 1180,
        hsnSac: '9983',
        gstRate: 18,
        taxableValue: 1000,
        cgstRate: 9,
        cgstAmount: 90,
        sgstRate: 9,
        sgstAmount: 90,
        igstRate: 0,
        igstAmount: 0,
      },
    ],
  };

  it('renders a GST invoice with supplier, recipient and tax breakup', () => {
    const html = renderGstInvoiceHtml(baseInvoice);
    expect(html).toContain('Tax Invoice');
    expect(html).toContain('INV-001');
    expect(html).toContain('Kaveri Studio');
    expect(html).toContain('33AABCU9603R1ZX');
    expect(html).toContain('Acme Corp');
    expect(html).toContain('29AABCU9603R1ZX');
    expect(html).toContain('Place of Supply');
    expect(html).toContain('CGST');
    expect(html).toContain('SGST');
    expect(html).toContain('IGST');
    expect(html).toContain('1,180.00');
  });

  it('throws for composition scheme invoices', () => {
    expect(() => renderGstInvoiceHtml({ ...baseInvoice, supplyType: 'composition' })).toThrow(
      'Composition scheme is not supported'
    );
  });

  it('throws for invoices with cess', () => {
    const line = { ...baseInvoice.lineItems[0], cessAmount: 10 } as GstInvoiceLineItem;
    expect(() => renderGstInvoiceHtml({ ...baseInvoice, lineItems: [line] })).toThrow(
      'Cess is not supported'
    );
  });
});
