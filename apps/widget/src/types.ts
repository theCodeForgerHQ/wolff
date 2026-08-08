export type WidgetMode = 'lead-form' | 'invoice-pay' | 'quote-link';

export interface WidgetConfig {
  apiBaseUrl: string;
  publishableKey: string;
  mode: WidgetMode;
  target: HTMLElement;
  invoiceToken?: string;
  quoteToken?: string;
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

export interface WidgetApiError {
  error: string;
  code: string;
}
