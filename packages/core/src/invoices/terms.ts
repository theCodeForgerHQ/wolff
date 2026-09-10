/**
 * The terms an invoice starts with: the workspace's default invoice terms
 * (Settings, Invoices), or none. A quote's own terms are about the quote
 * ("valid for 30 days", "accepting this quote...") and never carry over.
 */
export function defaultInvoiceTerms(settings: unknown): string | null {
  if (!settings || typeof settings !== 'object') return null;
  const defaults = (settings as { invoiceDefaults?: unknown }).invoiceDefaults;
  if (!defaults || typeof defaults !== 'object') return null;
  const terms = (defaults as { defaultTerms?: unknown }).defaultTerms;
  return typeof terms === 'string' && terms.trim() ? terms : null;
}
