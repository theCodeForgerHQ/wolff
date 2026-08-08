import { useState } from 'preact/compat';
import type { WidgetConfig } from '../types';
import { payInvoice } from '../api';

interface InvoicePayProps {
  config: WidgetConfig;
}

export function InvoicePay({ config }: InvoicePayProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const token = config.invoiceToken;

  const handlePay = async () => {
    if (!token) {
      setError('Invoice token is missing.');
      return;
    }

    setError(null);
    setIsLoading(true);

    try {
      const response = await payInvoice(config, token);
      config.onSuccess?.(response);
      window.open(response.checkoutUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to load payment link.';
      setError(message);
      config.onError?.(err instanceof Error ? err : new Error(message));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="ow-widget" aria-label="Invoice payment">
      <h2 className="ow-title">Pay invoice</h2>
      <p style={{ margin: '0 0 12px', fontSize: '14px', color: '#4b5563' }}>
        Click below to open a secure payment page.
      </p>
      <button
        type="button"
        className="ow-button"
        onClick={handlePay}
        disabled={isLoading || !token}
      >
        {isLoading ? 'Loading...' : 'Pay now'}
      </button>
      {error && (
        <div className="ow-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
