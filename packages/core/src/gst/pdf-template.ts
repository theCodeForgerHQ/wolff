import Decimal from 'decimal.js';

export interface GstInvoiceLineItem {
  name: string;
  description?: string | null;
  quantity: number;
  rate: number;
  amount: number;
  hsnSac?: string | null;
  gstRate?: number | null;
  taxableValue: number;
  cgstRate?: number | null;
  cgstAmount?: number | null;
  sgstRate?: number | null;
  sgstAmount?: number | null;
  igstRate?: number | null;
  igstAmount?: number | null;
  cessAmount?: number | null;
}

export interface GstInvoiceData {
  invoiceNumber: string;
  issueDate: Date;
  dueDate?: Date | null;
  supplierName: string;
  supplierAddress?: string;
  supplierGstin?: string | null;
  recipientName: string;
  recipientAddress?: string;
  recipientGstin?: string | null;
  placeOfSupply?: string | null;
  supplyType?: string | null;
  reverseCharge: boolean;
  currency: string;
  subtotal: number;
  discountAmount?: number;
  taxTotal: number;
  total: number;
  amountPaid?: number;
  amountDue?: number;
  lineItems: GstInvoiceLineItem[];
  irn?: string | null;
  ackNo?: string | null;
  ackDate?: Date | null;
  notes?: string | null;
}

function fmt(value: number | null | undefined, currency?: string): string {
  if (value === null || value === undefined) return '-';
  const n = new Decimal(value).toDecimalPlaces(2).toNumber();
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    currencyDisplay: 'symbol',
    ...(currency ? { style: 'currency', currency } : {}),
  });
}

function escapeHtml(text: string | null | undefined): string {
  if (text === null || text === undefined) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Renders a GST-compliant invoice HTML template. Throws if the invoice uses
 * composition scheme or cess, which are explicitly unsupported in Phase 3.
 */
export function renderGstInvoiceHtml(invoice: GstInvoiceData): string {
  const hasCess = invoice.lineItems.some((line) => (line.cessAmount ?? 0) > 0);
  if (hasCess) {
    throw new Error('Cess is not supported in the GST invoice template');
  }
  if (invoice.supplyType === 'composition') {
    throw new Error('Composition scheme is not supported in the GST invoice template');
  }

  const rows = invoice.lineItems
    .map(
      (line, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${escapeHtml(line.name)}<br><small>${escapeHtml(line.description)}</small></td>
      <td>${escapeHtml(line.hsnSac) ?? '-'}</td>
      <td class="num">${line.quantity}</td>
      <td class="num">${fmt(line.rate)}</td>
      <td class="num">${fmt(line.taxableValue)}</td>
      <td class="num">${line.gstRate ?? 0}%</td>
      <td class="num">${fmt(line.cgstAmount)}</td>
      <td class="num">${fmt(line.sgstAmount)}</td>
      <td class="num">${fmt(line.igstAmount)}</td>
      <td class="num">${fmt(line.amount)}</td>
    </tr>
  `
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Tax Invoice ${escapeHtml(invoice.invoiceNumber)}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; margin: 40px; color: #111; }
    h1 { font-size: 24px; margin-bottom: 8px; }
    .header { display: flex; justify-content: space-between; margin-bottom: 24px; }
    .party { width: 48%; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; }
    th, td { border: 1px solid #ccc; padding: 8px; text-align: left; }
    th { background: #f5f5f5; }
    .num { text-align: right; }
    .totals { margin-top: 16px; width: 320px; margin-left: auto; }
    .totals td { border: none; padding: 4px 8px; }
    .totals td:last-child { text-align: right; font-weight: 600; }
    .footer { margin-top: 32px; font-size: 12px; color: #555; }
    .qr { width: 120px; height: 120px; border: 1px dashed #999; display: flex; align-items: center; justify-content: center; margin-top: 16px; }
  </style>
</head>
<body>
  <h1>Tax Invoice</h1>
  <div class="header">
    <div class="party">
      <strong>${escapeHtml(invoice.supplierName)}</strong><br>
      ${escapeHtml(invoice.supplierAddress).replace(/\n/g, '<br>')}<br>
      GSTIN: ${escapeHtml(invoice.supplierGstin) ?? 'Unregistered'}
    </div>
    <div class="party">
      <strong>Invoice No:</strong> ${escapeHtml(invoice.invoiceNumber)}<br>
      <strong>Date:</strong> ${invoice.issueDate.toLocaleDateString('en-IN')}<br>
      ${invoice.dueDate ? `<strong>Due Date:</strong> ${invoice.dueDate.toLocaleDateString('en-IN')}<br>` : ''}
      <strong>Place of Supply:</strong> ${escapeHtml(invoice.placeOfSupply) ?? '-'}<br>
      <strong>Supply Type:</strong> ${escapeHtml(invoice.supplyType) ?? 'Regular'}<br>
      <strong>Reverse Charge:</strong> ${invoice.reverseCharge ? 'Yes' : 'No'}
    </div>
  </div>

  <div class="header">
    <div class="party">
      <strong>Bill To</strong><br>
      ${escapeHtml(invoice.recipientName)}<br>
      ${escapeHtml(invoice.recipientAddress).replace(/\n/g, '<br>')}<br>
      GSTIN: ${escapeHtml(invoice.recipientGstin) ?? 'Unregistered'}
    </div>
    <div class="party">
      ${invoice.irn ? `<strong>IRN:</strong> ${escapeHtml(invoice.irn)}<br>` : ''}
      ${invoice.ackNo ? `<strong>Ack No:</strong> ${escapeHtml(invoice.ackNo)}<br>` : ''}
      ${invoice.ackDate ? `<strong>Ack Date:</strong> ${invoice.ackDate.toLocaleDateString('en-IN')}<br>` : ''}
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>Description</th>
        <th>HSN/SAC</th>
        <th class="num">Qty</th>
        <th class="num">Rate</th>
        <th class="num">Taxable Value</th>
        <th class="num">GST %</th>
        <th class="num">CGST</th>
        <th class="num">SGST</th>
        <th class="num">IGST</th>
        <th class="num">Amount</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>

  <table class="totals">
    <tr><td>Subtotal</td><td>${fmt(invoice.subtotal, invoice.currency)}</td></tr>
    ${invoice.discountAmount ? `<tr><td>Discount</td><td>-${fmt(invoice.discountAmount, invoice.currency)}</td></tr>` : ''}
    <tr><td>Tax Total</td><td>${fmt(invoice.taxTotal, invoice.currency)}</td></tr>
    <tr><td>Total</td><td>${fmt(invoice.total, invoice.currency)}</td></tr>
    <tr><td>Amount Paid</td><td>${fmt(invoice.amountPaid ?? 0, invoice.currency)}</td></tr>
    <tr><td>Amount Due</td><td>${fmt(invoice.amountDue ?? invoice.total, invoice.currency)}</td></tr>
  </table>

  ${invoice.notes ? `<div class="footer"><strong>Notes:</strong> ${escapeHtml(invoice.notes)}</div>` : ''}

  <div class="footer">
    <p>This is a computer generated invoice and does not require a physical signature.</p>
    <div class="qr">QR code placeholder</div>
  </div>
</body>
</html>`;
}
