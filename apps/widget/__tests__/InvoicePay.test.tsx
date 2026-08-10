import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';
import { InvoicePay } from '../src/components/InvoicePay';
import type { WidgetConfig } from '../src/types';

const config: WidgetConfig = {
  apiBaseUrl: 'https://api.example.com',
  appUrl: 'https://app.example.com',
  publishableKey: 'wolff_pk_test',
  mode: 'invoice-pay',
  target: document.createElement('div'),
};

const respond = (body: unknown, ok = true) =>
  ({ ok, status: ok ? 200 : 404, json: async () => body }) as Response;

describe('InvoicePay', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
    vi.spyOn(window, 'open').mockImplementation(() => null);
    // The token comes from the link the client was emailed.
    window.history.replaceState(null, '', '/pay?inv=portal-token-123');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/');
    delete (window as { Razorpay?: unknown }).Razorpay;
  });

  it('pays with the token from the page URL and opens Stripe Checkout in a new tab', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      respond({ success: true, data: { provider: 'stripe', url: 'https://checkout.example.com' } })
    );

    render(<InvoicePay config={config} />);
    fireEvent.click(screen.getByRole('button', { name: /Pay now/ }));

    await waitFor(() => {
      expect(window.open).toHaveBeenCalledWith(
        'https://checkout.example.com',
        '_blank',
        'noopener,noreferrer'
      );
    });
    const [url, init] = vi.mocked(global.fetch).mock.calls[0]!;
    expect(url).toBe('https://api.example.com/v1/public/invoices/portal-token-123/pay');
    // Origin is the browser's to set; a page cannot forge it.
    expect((init!.headers as Record<string, string>).Origin).toBeUndefined();
  });

  it('opens the Razorpay checkout for a Razorpay order', async () => {
    const open = vi.fn();
    const Razorpay = vi.fn(function (this: { open: () => void }) {
      this.open = open;
    });
    (window as { Razorpay?: unknown }).Razorpay = Razorpay;
    vi.mocked(global.fetch).mockResolvedValueOnce(
      respond({
        success: true,
        data: {
          provider: 'razorpay',
          orderId: 'order_1',
          amount: 100000,
          currency: 'INR',
          keyId: 'rzp_test_1',
          prefill: {},
        },
      })
    );

    render(<InvoicePay config={config} />);
    fireEvent.click(screen.getByRole('button', { name: /Pay now/ }));

    await waitFor(() => expect(open).toHaveBeenCalled());
    expect(Razorpay).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'rzp_test_1', order_id: 'order_1', amount: 100000 })
    );
  });

  it('shows the API error message', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      respond({ success: false, error: { code: 'not_found', message: 'Invoice not found' } }, false)
    );

    render(<InvoicePay config={config} />);
    fireEvent.click(screen.getByRole('button', { name: /Pay now/ }));

    expect((await screen.findByRole('alert')).textContent).toContain('Invoice not found');
  });

  it('cannot pay without a token in the URL', () => {
    window.history.replaceState(null, '', '/pay');

    render(<InvoicePay config={config} />);

    expect((screen.getByRole('button', { name: /Pay now/ }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });
});
