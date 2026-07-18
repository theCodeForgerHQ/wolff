import { describe, it, expect } from 'vitest';
import { getPdfDownloadUrl } from '@/lib/pdf/client-download';

describe('getPdfDownloadUrl', () => {
  it('builds the quote download URL', () => {
    expect(getPdfDownloadUrl('quote', 'abc123')).toBe('/api/download/quote/abc123');
  });

  it('builds the invoice download URL', () => {
    expect(getPdfDownloadUrl('invoice', 'inv_9')).toBe('/api/download/invoice/inv_9');
  });

  it('encodes unsafe id characters', () => {
    expect(getPdfDownloadUrl('quote', 'a/b?c')).toBe('/api/download/quote/a%2Fb%3Fc');
  });
});
