import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@stripe/stripe-js', () => ({ loadStripe: vi.fn().mockResolvedValue(null) }));
vi.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="elements">{children}</div>
  ),
  PaymentElement: () => <div data-testid="payment-element" />,
  useStripe: () => null,
  useElements: () => null,
}));

import { PaymentForm } from '@/components/client-portal/payment-form';

function mockCheckoutResponse(body: Record<string, unknown>, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body })
  );
}

function renderForm() {
  const onSuccess = vi.fn();
  const onCancel = vi.fn();
  render(
    <PaymentForm
      invoiceId="inv-1"
      accessToken="tok"
      amountDue={250}
      currency="USD"
      onSuccess={onSuccess}
      onCancel={onCancel}
    />
  );
  return { onSuccess, onCancel };
}

describe('PaymentForm', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the payment element once the checkout route returns a client secret', async () => {
    mockCheckoutResponse({ clientSecret: 'pi_1_secret_2', paymentIntentId: 'pi_1' });

    const { onSuccess } = renderForm();

    expect(await screen.findByTestId('payment-element')).toBeInTheDocument();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('shows the error from the checkout route', async () => {
    mockCheckoutResponse({ error: 'Invoice has been voided' }, 400);

    renderForm();

    expect(await screen.findByText('Invoice has been voided')).toBeInTheDocument();
  });

  it('treats an already received payment as paid instead of showing an error', async () => {
    mockCheckoutResponse(
      { alreadyReceived: true, error: 'We have already received a payment for this invoice.' },
      409
    );

    const { onSuccess } = renderForm();

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/already received/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('payment-element')).not.toBeInTheDocument();
  });
});
