import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/image', () => ({ default: () => null }));

const item = {
  id: 'b1',
  type: 'service-item',
  content: { name: 'Workshop', quantity: 2, rate: 1500 },
};

vi.mock('@/components/quotes/editor/hooks/useQuoteForm', () => ({
  useQuoteForm: () => ({
    document: { currency: 'INR', settings: {}, blocks: [item], notes: '', terms: '' },
    isDirty: false,
    isSaving: false,
    client: null,
    title: 'Quote',
    projectId: null,
    expirationDays: 30,
    taxRate: 0,
  }),
}));
vi.mock('@/components/quotes/editor/hooks/useQuoteSave', () => ({
  useQuoteSave: () => ({ isLoading: false, isSending: false, showSendConfirm: false }),
}));
vi.mock('@/components/quotes/editor/hooks/useLogoUpload', () => ({
  useLogoUpload: () => ({ logoUrl: null, isUploadingLogo: false }),
}));
vi.mock('@/components/quotes/editor/hooks/useQuoteTotals', () => ({
  useQuoteTotals: () => ({ serviceItems: [item], subtotal: 3000, taxAmount: 0, total: 3000 }),
}));
for (const section of ['DetailsSection', 'ItemsSection', 'TermsSection', 'NotesSection']) {
  vi.doMock(`@/components/quotes/editor/sections/${section}`, () => ({ [section]: () => null }));
}

describe('QuoteEditor preview', () => {
  // A quote in rupees showed its line amounts in dollars.
  it("shows every amount in the quote's currency", async () => {
    const { QuoteEditor } = await import('@/components/quotes/editor/QuoteEditor');
    render(<QuoteEditor />);

    const line = screen.getByText(/Workshop/).parentElement!;
    expect(line.textContent).toContain('₹');
    expect(document.body.textContent).not.toContain('$');
  });
});
