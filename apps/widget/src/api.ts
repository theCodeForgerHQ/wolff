import type { LeadFormData, WidgetApiError, WidgetConfig } from './types';

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
    headers: {
      'Content-Type': 'application/json',
      'X-Publishable-Key': config.publishableKey,
      Origin: typeof window !== 'undefined' ? window.location.origin : '',
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
    throw new Error(body?.error ?? `HTTP ${response.status}`);
  }

  return (await response.json()) as T;
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
): Promise<{ id: string; message: string }> {
  return request<{ id: string; message: string }>(config, '/v1/public/leads', {
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

export async function payInvoice(
  config: WidgetConfig,
  token: string
): Promise<{ checkoutUrl: string; provider: string }> {
  return request<{ checkoutUrl: string; provider: string }>(
    config,
    `/v1/public/invoices/${token}/pay`,
    {
      method: 'POST',
    }
  );
}

export async function getQuotePublic(
  config: WidgetConfig,
  token: string
): Promise<{ id: string; title: string; status: string }> {
  return request<{ id: string; title: string; status: string }>(
    config,
    `/v1/public/quotes/${token}`,
    {
      method: 'GET',
    }
  );
}
