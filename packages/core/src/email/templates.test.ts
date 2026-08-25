import { describe, expect, it } from 'vitest';
import { formatMoney, renderInvoiceSent, renderQuoteSent } from './templates';

describe('renderQuoteSent', () => {
  const base = {
    clientName: 'Kaveri',
    quoteName: 'Website redesign',
    quoteUrl: 'https://app.example.test/q/abc',
    businessName: 'Parity Studio',
  };

  it('names the quote and links to the portal', () => {
    const email = renderQuoteSent(base);
    expect(email.subject).toBe('Quote: Website redesign from Parity Studio');
    expect(email.html).toContain('<strong>Website redesign</strong>');
    expect(email.html).toContain('href="https://app.example.test/q/abc"');
  });

  it('adds the message and the validity date only when given', () => {
    expect(renderQuoteSent(base).html).not.toContain('valid until');
    const email = renderQuoteSent({
      ...base,
      message: 'Please review',
      validUntil: new Date('2026-12-31T00:00:00Z'),
    });
    expect(email.html).toContain('<p>Please review</p>');
    expect(email.html).toContain('valid until 31 Dec 2026');
  });

  it('escapes what the sender or client typed', () => {
    const email = renderQuoteSent({
      ...base,
      clientName: '<script>x</script>',
      message: '"><img src=x onerror=alert(1)>',
    });
    expect(email.html).not.toContain('<script>');
    expect(email.html).not.toContain('<img');
    expect(email.html).toContain('&lt;script&gt;');
  });

  it('never links to a non-http URL', () => {
    expect(renderQuoteSent({ ...base, quoteUrl: 'javascript:alert(1)' }).html).toContain(
      'href="#"'
    );
  });
});

describe('renderInvoiceSent', () => {
  const email = renderInvoiceSent({
    clientName: 'Kaveri',
    invoiceNumber: 'INV-0042',
    invoiceUrl: 'https://app.example.test/i/abc',
    businessName: 'Parity Studio',
    amount: formatMoney(5900, 'INR'),
    dueDate: new Date('2026-12-01T00:00:00Z'),
  });

  it('shows the amount in the invoice currency', () => {
    expect(email.subject).toBe('Invoice INV-0042 from Parity Studio - ₹5,900.00');
    expect(email.html).toContain('<strong>Amount:</strong> ₹5,900.00');
  });

  it('shows the due date and the payment link', () => {
    expect(email.html).toContain('<strong>Due Date:</strong> 1 Dec 2026');
    expect(email.html).toContain('href="https://app.example.test/i/abc"');
  });
});
