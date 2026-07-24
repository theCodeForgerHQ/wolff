// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * lib/services/stripe.ts is the only module that holds the Stripe client, and
 * every function in it parses its input before calling the SDK. The SDK is
 * replaced by a recorder here, so "rejected" means the request was never
 * built, not that Stripe refused it.
 */
const sdk = vi.hoisted(() => ({
  paymentIntentsCancel: vi.fn(),
  accountsCreate: vi.fn(),
  accountsRetrieve: vi.fn(),
  accountLinksCreate: vi.fn(),
  checkoutSessionsCreate: vi.fn(),
  refundsCreate: vi.fn(),
}));

vi.mock('stripe', () => ({
  default: class FakeStripe {
    paymentIntents = { cancel: sdk.paymentIntentsCancel };
    accounts = { create: sdk.accountsCreate, retrieve: sdk.accountsRetrieve };
    accountLinks = { create: sdk.accountLinksCreate };
    checkout = { sessions: { create: sdk.checkoutSessionsCreate } };
    refunds = { create: sdk.refundsCreate };
  },
}));

vi.hoisted(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_wolff';
});

import * as service from '@/lib/services/stripe';

const checkout = {
  invoiceId: '00000000-0000-4000-8000-00000000a002',
  amount: 150_000,
  currency: 'USD',
  description: 'Invoice INV-0001',
  customerEmail: 'client@example.com',
  successUrl: 'https://app.example.com/i/tok?paid=1',
  cancelUrl: 'https://app.example.com/i/tok',
};

const onboardingLink = {
  accountId: 'acct_1Abc',
  refreshUrl: 'https://app.example.com/settings/payments?refresh=true',
  returnUrl: 'https://app.example.com/settings/payments?success=true',
};

describe('lib/services/stripe validates before calling the SDK', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not export the raw client', () => {
    expect(Object.keys(service)).not.toContain('stripe');
  });

  it('never sends a zero-cent refund', async () => {
    await expect(service.createRefund({ paymentIntentId: 'pi_123', amount: 0 })).rejects.toThrow();
    expect(sdk.refundsCreate).not.toHaveBeenCalled();
  });

  describe('cancelPaymentIntent', () => {
    it('cancels a well-formed id', async () => {
      sdk.paymentIntentsCancel.mockResolvedValue({ id: 'pi_123', status: 'canceled' });
      await service.cancelPaymentIntent('pi_123');
      expect(sdk.paymentIntentsCancel).toHaveBeenCalledWith('pi_123');
    });

    it('rejects an id that would change the request path', async () => {
      await expect(service.cancelPaymentIntent('pi_1/../../v1/refunds')).rejects.toThrow();
      expect(sdk.paymentIntentsCancel).not.toHaveBeenCalled();
    });
  });

  describe('createConnectAccount', () => {
    it('creates a standard account tagged with the workspace', async () => {
      sdk.accountsCreate.mockResolvedValue({ id: 'acct_new' });

      await service.createConnectAccount({
        workspaceId: 'ws-1',
        email: 'owner@example.com',
        businessName: 'Acme Design Studio',
      });

      expect(sdk.accountsCreate).toHaveBeenCalledWith({
        type: 'standard',
        country: 'US',
        email: 'owner@example.com',
        business_profile: { name: 'Acme Design Studio' },
        metadata: { workspaceId: 'ws-1' },
      });
    });

    it('omits an email and business name it was not given', async () => {
      sdk.accountsCreate.mockResolvedValue({ id: 'acct_new' });

      await service.createConnectAccount({ workspaceId: 'ws-1' });

      expect(sdk.accountsCreate).toHaveBeenCalledWith({
        type: 'standard',
        country: 'US',
        metadata: { workspaceId: 'ws-1' },
      });
    });

    it.each([
      ['a malformed email', { email: 'not-an-email' }],
      ['a workspace id with separators', { workspaceId: 'ws/1?x' }],
      ['an over-long business name', { businessName: 'x'.repeat(5001) }],
    ])('rejects %s', async (_label, patch) => {
      await expect(
        service.createConnectAccount({ workspaceId: 'ws-1', ...patch })
      ).rejects.toThrow();
      expect(sdk.accountsCreate).not.toHaveBeenCalled();
    });
  });

  describe('retrieveConnectAccount', () => {
    it('rejects an id that is not an account id', async () => {
      await expect(service.retrieveConnectAccount('cus_123')).rejects.toThrow();
      expect(sdk.accountsRetrieve).not.toHaveBeenCalled();
    });
  });

  describe('createAccountOnboardingLink', () => {
    it('creates an onboarding link', async () => {
      sdk.accountLinksCreate.mockResolvedValue({ url: 'https://connect.stripe.com/setup/x' });

      await service.createAccountOnboardingLink(onboardingLink);

      expect(sdk.accountLinksCreate).toHaveBeenCalledWith({
        account: 'acct_1Abc',
        refresh_url: onboardingLink.refreshUrl,
        return_url: onboardingLink.returnUrl,
        type: 'account_onboarding',
      });
    });

    it.each([
      ['a return URL that is not http(s)', { returnUrl: 'javascript:alert(1)' }],
      ['a relative refresh URL', { refreshUrl: '/settings/payments' }],
      ['a malformed account id', { accountId: 'acct_1/../x' }],
    ])('rejects %s', async (_label, patch) => {
      await expect(
        service.createAccountOnboardingLink({ ...onboardingLink, ...patch })
      ).rejects.toThrow();
      expect(sdk.accountLinksCreate).not.toHaveBeenCalled();
    });
  });

  describe('createCheckoutSession', () => {
    it('creates a one-line card payment session', async () => {
      sdk.checkoutSessionsCreate.mockResolvedValue({ id: 'cs_1', url: 'https://checkout' });

      await service.createCheckoutSession(checkout);

      expect(sdk.checkoutSessionsCreate).toHaveBeenCalledWith({
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: { name: 'Invoice INV-0001' },
              unit_amount: 150_000,
            },
            quantity: 1,
          },
        ],
        customer_email: 'client@example.com',
        success_url: checkout.successUrl,
        cancel_url: checkout.cancelUrl,
        metadata: { invoiceId: checkout.invoiceId },
      });
    });

    it.each([
      ['a fractional amount', { amount: 10.5 }],
      ['NaN', { amount: Number.NaN }],
      ['a zero amount', { amount: 0 }],
      ['a currency that is not 3 letters', { currency: 'US$' }],
      ['a malformed customer email', { customerEmail: 'nope' }],
      ['a success URL that is not http(s)', { successUrl: 'javascript:alert(1)' }],
      ['an empty description', { description: '' }],
    ])('rejects %s', async (_label, patch) => {
      await expect(service.createCheckoutSession({ ...checkout, ...patch })).rejects.toThrow();
      expect(sdk.checkoutSessionsCreate).not.toHaveBeenCalled();
    });
  });
});
