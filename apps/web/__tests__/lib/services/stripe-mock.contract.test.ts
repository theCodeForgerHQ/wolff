// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Sends Wolff's real Stripe requests to stripe-mock, which validates every
 * request against Stripe's OpenAPI spec and answers with fixture objects.
 * This catches parameters an API or SDK upgrade no longer accepts, without
 * Stripe keys. Run stripe-mock and set STRIPE_MOCK_URL (CI does):
 *
 *   docker run -p 12111:12111 stripe/stripe-mock:latest
 *   STRIPE_MOCK_URL=http://localhost:12111 pnpm vitest run stripe-mock
 */
const mockUrl = process.env.STRIPE_MOCK_URL;

describe.skipIf(!mockUrl)('Stripe requests against stripe-mock', () => {
  let service: typeof import('@/lib/services/stripe');
  let provider: import('@/lib/providers/stripe-provider').StripeProvider;

  beforeAll(async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_wolff');
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_test');
    vi.stubEnv('STRIPE_API_BASE_URL', mockUrl!);
    vi.resetModules();
    service = await import('@/lib/services/stripe');
    const { StripeProvider } = await import('@/lib/providers/stripe-provider');
    provider = new StripeProvider();
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it('creates a destination-charge PaymentIntent', async () => {
    const intent = await service.createPaymentIntent({
      amount: 150_000,
      currency: 'USD',
      invoiceId: 'inv_contract',
      customerId: 'cus_contract',
      stripeAccountId: 'acct_contract',
      metadata: { workspaceId: 'ws_contract' },
      attempt: 0,
    });
    expect(intent?.object).toBe('payment_intent');
    expect(intent?.id).toMatch(/^pi_/);
  });

  it('retrieves a PaymentIntent', async () => {
    const intent = await service.retrievePaymentIntent('pi_contract');
    expect(intent?.object).toBe('payment_intent');
  });

  it('looks up or creates a customer', async () => {
    const customer = await service.getOrCreateCustomer({
      email: 'client@example.com',
      name: 'Client',
      metadata: { workspaceId: 'ws_contract' },
    });
    expect(customer?.object).toBe('customer');
  });

  it('creates a partial refund with a reason', async () => {
    const refund = await service.createRefund({
      paymentIntentId: 'pi_contract',
      amount: 5_000,
      reason: 'requested_by_customer',
    });
    expect(refund?.object).toBe('refund');
  });

  it('creates a Checkout Session for an invoice', async () => {
    const session = await provider.createCheckoutSession({
      invoiceId: 'inv_contract',
      amount: 1500,
      currency: 'USD',
      description: 'Invoice INV-0001',
      customerEmail: 'client@example.com',
      successUrl: 'https://app.example.com/i/tok?paid=1',
      cancelUrl: 'https://app.example.com/i/tok',
    });
    expect(session.sessionId).toMatch(/^cs_/);
  });

  it('creates a Connect account and its onboarding link (lib/payments/actions.ts)', async () => {
    const stripe = service.stripe!;
    const account = await stripe.accounts.create({
      type: 'standard',
      country: 'US',
      email: 'owner@example.com',
      business_profile: { name: 'Acme Design Studio' },
      metadata: { workspaceId: 'ws_contract' },
    });
    expect(account.object).toBe('account');

    const link = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: 'https://app.example.com/settings/payments?refresh=1',
      return_url: 'https://app.example.com/settings/payments?connected=1',
      type: 'account_onboarding',
    });
    expect(link.object).toBe('account_link');

    const retrieved = await stripe.accounts.retrieve(account.id);
    expect(typeof retrieved.charges_enabled).toBe('boolean');
  });

  it('cancels a PaymentIntent', async () => {
    const cancelled = await service.stripe!.paymentIntents.cancel('pi_contract');
    expect(cancelled.object).toBe('payment_intent');
  });
});
