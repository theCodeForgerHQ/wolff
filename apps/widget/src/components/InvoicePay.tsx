import { useState } from 'preact/compat';
import type { WidgetConfig } from '../types';
import { payInvoice, tokenFromPage } from '../api';
import type { PaymentStart } from '../types';

const RAZORPAY_CHECKOUT = 'https://checkout.razorpay.com/v1/checkout.js';

type RazorpayOrder = Extract<PaymentStart, { provider: 'razorpay' }>;
interface RazorpayCheckout {
  open(): void;
}
type RazorpayConstructor = new (options: Record<string, unknown>) => RazorpayCheckout;

function loadRazorpay(): Promise<RazorpayConstructor> {
  const existing = (window as { Razorpay?: RazorpayConstructor }).Razorpay;
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = RAZORPAY_CHECKOUT;
    script.async = true;
    script.onload = () => {
      const loaded = (window as { Razorpay?: RazorpayConstructor }).Razorpay;
      if (loaded) resolve(loaded);
      else reject(new Error('Razorpay checkout did not load.'));
    };
    script.onerror = () => reject(new Error('Razorpay checkout did not load.'));
    document.head.appendChild(script);
  });
}

/**
 * Opens Razorpay's own checkout modal (served from checkout.razorpay.com).
 * Its success callback is for the page only; the invoice is marked paid by
 * the webhook.
 */
async function openRazorpayCheckout(order: RazorpayOrder): Promise<void> {
  const Razorpay = await loadRazorpay();
  new Razorpay({
    key: order.keyId,
    order_id: order.orderId,
    amount: order.amount,
    currency: order.currency,
    prefill: order.prefill ?? {},
  }).open();
}

interface InvoicePayProps {
  config: WidgetConfig;
}

export function InvoicePay({ config }: InvoicePayProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const token = tokenFromPage('inv');

  const handlePay = async () => {
    if (!token) {
      setError('Invoice token is missing.');
      return;
    }

    setError(null);
    setIsLoading(true);

    try {
      const payment = await payInvoice(config, token);
      config.onSuccess?.(payment);
      if (payment.provider === 'stripe') {
        // No card fields in the widget: Checkout opens in its own tab.
        window.open(payment.url, '_blank', 'noopener,noreferrer');
      } else {
        await openRazorpayCheckout(payment);
      }
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
