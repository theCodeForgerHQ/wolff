import { describe, expect, it } from 'vitest';
import { canPayOnline } from '@/lib/invoices/can-pay';

const payable = {
  status: 'sent',
  amountDue: 250,
  stripeOnboardingComplete: true,
  publishableKey: 'pk_test_wolff',
};

describe('canPayOnline', () => {
  it('offers online payment for an open invoice on a fully configured workspace', () => {
    expect(canPayOnline(payable)).toBe(true);
  });

  it.each([
    ['the invoice is paid', { status: 'paid' }],
    ['the invoice is voided', { status: 'voided' }],
    ['nothing is due', { amountDue: 0 }],
    ['Stripe onboarding is incomplete', { stripeOnboardingComplete: false }],
    ['the workspace has no payment settings', { stripeOnboardingComplete: undefined }],
    ['the publishable key is missing, so Stripe.js cannot load', { publishableKey: undefined }],
    ['the publishable key is empty', { publishableKey: '' }],
  ])('does not offer it when %s', (_label, patch) => {
    expect(canPayOnline({ ...payable, ...patch })).toBe(false);
  });
});
