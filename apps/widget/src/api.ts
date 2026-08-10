import type { LeadFormData, PaymentStart, WidgetApiError, WidgetConfig } from './types';

const MIN_SUBMIT_MS = 2000;

function buildUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}${path}`;
}

async function request<T>(
  config: WidgetConfig,
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const url = buildUrl(config.apiBaseUrl, path);
  const response = await fetch(url, {
    ...options,
    // The browser sends Origin itself; the API checks it against the key.
    headers: {
      'Content-Type': 'application/json',
      'X-Publishable-Key': config.publishableKey,
      ...options.headers,
    },
    credentials: 'omit',
    mode: 'cors',
  });

  if (!response.ok) {
    let body: WidgetApiError | null = null;
    try {
      body = (await response.json()) as WidgetApiError;
    } catch {
      // ignore parse error
    }
    throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
  }

  const body = (await response.json()) as { data: T };
  return body.data;
}

export function isBotSubmission(data: LeadFormData): boolean {
  // Honeypot: website field should be empty
  if (data.website && data.website.trim().length > 0) return true;
  // Time-to-submit: too fast is suspicious
  if (Date.now() - data._startTime < MIN_SUBMIT_MS) return true;
  return false;
}

export async function submitLead(
  config: WidgetConfig,
  data: LeadFormData
): Promise<{ message: string }> {
  return request<{ message: string }>(config, '/v1/public/leads', {
    method: 'POST',
    body: JSON.stringify({
      name: data.name,
      email: data.email,
      phone: data.phone,
      company: data.company,
      message: data.message,
    }),
  });
}

/** The portal token from the link the client was emailed: `?inv=` or `?quote=`. */
export function tokenFromPage(param: 'inv' | 'quote'): string | null {
  if (typeof window === 'undefined') return null;
  const value = new URLSearchParams(window.location.search).get(param)?.trim();
  return value ? value : null;
}

export async function payInvoice(config: WidgetConfig, token: string): Promise<PaymentStart> {
  return request<PaymentStart>(config, `/v1/public/invoices/${encodeURIComponent(token)}/pay`, {
    method: 'POST',
    body: '{}',
  });
}
