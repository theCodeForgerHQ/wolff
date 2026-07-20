import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PublicInvoiceData } from '@/lib/invoices/portal-actions';

vi.mock('@/components/client-portal/payment-form', () => ({
  PaymentForm: (props: { invoiceId: string; onSuccess: () => void; onCancel: () => void }) => (
    <div data-testid="payment-form">
      payment form for {props.invoiceId}
      <button onClick={props.onSuccess}>simulate success</button>
      <button onClick={props.onCancel}>simulate cancel</button>
    </div>
  ),
}));

import { InvoicePortalView } from '@/components/client-portal/invoice-portal-view';

function invoice(overrides: Partial<PublicInvoiceData> = {}): PublicInvoiceData {
  return {
    id: 'inv-1',
    invoiceNumber: 'INV-0001',
    status: 'sent',
    title: 'Website redesign',
    currency: 'USD',
    issueDate: '2026-09-01T00:00:00.000Z',
    dueDate: '2026-10-01T00:00:00.000Z',
    isOverdue: false,
    daysOverdue: 0,
    totals: { subtotal: 1800, discountAmount: 0, taxTotal: 0, total: 1800, amountPaid: 0, amountDue: 1800 },
    settings: { currency: 'USD', showLineItemPrices: true },
    notes: '',
    terms: '',
    client: { id: 'c1', name: 'Global Retail Co.', email: 'ap@example.com', company: null },
    business: { name: 'Acme Design Studio', email: null, phone: null, logoUrl: null, address: null },
    branding: { primaryColor: null, accentColor: null, logoUrl: null },
    lineItems: [],
    payments: [],
    canPay: true,
    paymentConfigured: true,
    ...overrides,
  };
}

describe('InvoicePortalView payment', () => {
  it('opens the Stripe payment form from the Pay button', () => {
    render(<InvoicePortalView invoice={invoice()} accessToken="tok" />);

    fireEvent.click(screen.getByRole('button', { name: /pay \$\s?1,800\.00/i }));

    expect(screen.getByTestId('payment-form')).toHaveTextContent('payment form for inv-1');
  });

  it('shows a confirmation once the payment is submitted', () => {
    render(<InvoicePortalView invoice={invoice()} accessToken="tok" />);
    fireEvent.click(screen.getByRole('button', { name: /pay/i }));

    fireEvent.click(screen.getByRole('button', { name: 'simulate success' }));

    expect(screen.getByRole('status')).toHaveTextContent('Payment received');
    expect(screen.queryByTestId('payment-form')).not.toBeInTheDocument();
  });

  it('returns to the Pay button when the payment is cancelled', () => {
    render(<InvoicePortalView invoice={invoice()} accessToken="tok" />);
    fireEvent.click(screen.getByRole('button', { name: /pay/i }));

    fireEvent.click(screen.getByRole('button', { name: 'simulate cancel' }));

    expect(screen.getByRole('button', { name: /pay/i })).toBeInTheDocument();
  });

  it('offers no Pay button when online payment is not configured', () => {
    render(<InvoicePortalView invoice={invoice({ canPay: false })} accessToken="tok" />);
    expect(screen.queryByRole('button', { name: /^pay/i })).not.toBeInTheDocument();
  });
});
