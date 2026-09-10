import { describe, expect, it } from 'vitest';
import { defaultInvoiceTerms } from './terms';

describe('defaultInvoiceTerms', () => {
  it("uses the workspace's default invoice terms", () => {
    expect(
      defaultInvoiceTerms({ invoiceDefaults: { defaultTerms: 'Payment due in 30 days.' } })
    ).toBe('Payment due in 30 days.');
  });

  it.each([
    ['no settings', null],
    ['no invoice defaults', { other: 1 }],
    ['blank terms', { invoiceDefaults: { defaultTerms: '   ' } }],
    ['terms that are not text', { invoiceDefaults: { defaultTerms: 42 } }],
  ])('gives none for %s', (_name, settings) => {
    expect(defaultInvoiceTerms(settings)).toBeNull();
  });
});
