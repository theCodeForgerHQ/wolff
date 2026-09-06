import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  onboarding: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('@/lib/payments/actions', () => ({
  updatePaymentSettings: mocks.update,
  createStripeOnboardingLink: mocks.onboarding,
  checkStripeAccountStatus: vi.fn(),
}));

import { PaymentSettingsForm } from '@/components/payments/payment-settings-form';

const REFUSED = { success: false, error: 'Only admins and owners can manage payments' };

describe('PaymentSettingsForm', () => {
  beforeEach(() => vi.clearAllMocks());

  // The actions report a refusal in their result; they do not throw.
  it('shows the refusal instead of "saved" when the save is refused', async () => {
    mocks.update.mockResolvedValue(REFUSED);
    render(<PaymentSettingsForm initialData={null} stripeEnabled />);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith(REFUSED.error));
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });

  it('still confirms a successful save', async () => {
    mocks.update.mockResolvedValue({ success: true });
    render(<PaymentSettingsForm initialData={null} stripeEnabled />);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalled());
  });

  it('shows why connecting Stripe was refused', async () => {
    mocks.onboarding.mockResolvedValue(REFUSED);
    render(<PaymentSettingsForm initialData={null} stripeEnabled />);
    fireEvent.click(screen.getByRole('button', { name: /connect with stripe/i }));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith(REFUSED.error));
  });
});
