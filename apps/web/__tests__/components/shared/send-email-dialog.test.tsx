import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const sendQuote = vi.hoisted(() => vi.fn(async () => ({ success: true, emailSent: true })));
vi.mock('@/lib/quotes/actions', () => ({ sendQuote }));
vi.mock('@/lib/invoices/status-actions', () => ({ sendInvoice: vi.fn() }));
vi.mock('@/lib/contracts/actions', () => ({ sendContractInstance: vi.fn() }));
vi.mock('@/lib/email/actions', () => ({
  getEmailTemplates: async () => [],
  getEmailTemplateById: async () => null,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { SendEmailDialog } from '@/components/shared/send-email-dialog';

describe('SendEmailDialog', () => {
  it('sends the subject it shows when none is typed', async () => {
    render(
      <SendEmailDialog
        open
        onOpenChange={() => {}}
        type="quote"
        documentId="q1"
        documentNumber="Q-0008"
        recipientEmail="meera@example.test"
        recipientName="Meera Raghavan"
        businessName="Acme Design Studio"
      />
    );

    expect(screen.getAllByText('Quote #Q-0008 from Acme Design Studio').length).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /send email/i }));
    });

    await waitFor(() => expect(sendQuote).toHaveBeenCalled());
    expect(sendQuote).toHaveBeenCalledWith(
      'q1',
      expect.objectContaining({ subject: 'Quote #Q-0008 from Acme Design Studio' })
    );
  });
});
