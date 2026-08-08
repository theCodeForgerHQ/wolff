import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';
import { InvoicePay } from '../src/components/InvoicePay';
import type { WidgetConfig } from '../src/types';

describe('InvoicePay', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
    vi.spyOn(window, 'open').mockImplementation(() => null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens the checkout URL in a new tab', async () => {
    const config: WidgetConfig = {
      apiBaseUrl: 'https://api.example.com',
      publishableKey: 'wolff_pk_test',
      mode: 'invoice-pay',
      target: document.createElement('div'),
      invoiceToken: 'inv-token-123',
    };

    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ checkoutUrl: 'https://checkout.example.com', provider: 'stripe' }),
    } as Response);

    render(<InvoicePay config={config} />);
    fireEvent.click(screen.getByRole('button', { name: /Pay now/ }));

    await waitFor(() => {
      expect(window.open).toHaveBeenCalledWith(
        'https://checkout.example.com',
        '_blank',
        'noopener,noreferrer'
      );
    });
  });
});
