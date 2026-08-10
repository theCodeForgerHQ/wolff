export type WidgetMode = 'lead-form' | 'invoice-pay' | 'quote-link';

export interface WidgetConfig {
  apiBaseUrl: string;
  /** The product's own origin, where the hosted quote portal lives. */
  appUrl: string;
  publishableKey: string;
  mode: WidgetMode;
  target: HTMLElement;
  onSuccess?: (data: unknown) => void;
  onError?: (error: Error) => void;
}

export interface LeadFormData {
  name: string;
  email: string;
  phone?: string;
  company?: string;
  message?: string;
  website?: string; // honeypot
  _startTime: number;
}

/** The API's error envelope. */
export interface WidgetApiError {
  success: false;
  error?: { code: string; message: string };
}

/** What POST /v1/public/invoices/:token/pay answers with. */
export type PaymentStart =
  | { provider: 'stripe'; url: string }
  | {
      provider: 'razorpay';
      orderId: string;
      amount: number;
      currency: string;
      keyId: string;
      prefill?: { name?: string; email?: string; contact?: string };
    };
