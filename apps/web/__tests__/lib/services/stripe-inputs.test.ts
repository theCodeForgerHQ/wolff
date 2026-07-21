// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  customerInput,
  parseStripeApiBase,
  paymentIntentId,
  paymentIntentInput,
  refundInput,
} from '@/lib/services/stripe-inputs';

const validIntent = {
  amount: 150_000,
  currency: 'USD',
  invoiceId: '00000000-0000-4000-8000-00000000a002',
  customerId: 'cus_Q1w2E3r4',
  stripeAccountId: 'acct_1Abc',
  metadata: { workspaceId: 'ws-1', invoiceNumber: 'INV-0001' },
  attempt: 0,
};

describe('paymentIntentInput', () => {
  it('accepts server data and lower-cases the currency', () => {
    expect(paymentIntentInput.parse(validIntent).currency).toBe('usd');
  });

  it.each([
    ['a zero amount', { amount: 0 }],
    ['a negative amount', { amount: -1 }],
    ['a fractional amount', { amount: 10.5 }],
    ['NaN', { amount: Number.NaN }],
    ['a currency that is not 3 letters', { currency: 'US$' }],
    ['an account id with path characters', { stripeAccountId: 'acct_1/../../v1/charges' }],
    ['a customer id with the wrong prefix', { customerId: 'acct_123' }],
    ['an invoice id with separators', { invoiceId: 'inv_1?x=1' }],
    ['a negative attempt', { attempt: -1 }],
    ['a fractional attempt', { attempt: 0.5 }],
    ['a metadata value over 500 chars', { metadata: { note: 'x'.repeat(501) } }],
  ])('rejects %s', (_label, patch) => {
    expect(paymentIntentInput.safeParse({ ...validIntent, ...patch }).success).toBe(false);
  });
});

describe('refundInput', () => {
  it('treats an omitted amount as a full refund', () => {
    expect(refundInput.parse({ paymentIntentId: 'pi_123' }).amount).toBeUndefined();
  });

  it('rejects a zero amount instead of turning it into a full refund', () => {
    // Math.round(0.004 * 100) === 0 used to be dropped by `amount && {...}`.
    expect(refundInput.safeParse({ paymentIntentId: 'pi_123', amount: 0 }).success).toBe(false);
  });

  it('rejects an unknown refund reason', () => {
    expect(refundInput.safeParse({ paymentIntentId: 'pi_123', reason: 'because' }).success).toBe(
      false
    );
  });

  it('rejects a payment intent id that could change the request path', () => {
    expect(paymentIntentId.safeParse('pi_123/refunds').success).toBe(false);
    expect(paymentIntentId.safeParse('ch_123').success).toBe(false);
  });
});

describe('customerInput', () => {
  it('requires a valid email and a non-empty name', () => {
    expect(customerInput.safeParse({ email: 'client@example.com', name: 'Client' }).success).toBe(
      true
    );
    expect(customerInput.safeParse({ email: 'not-an-email', name: 'Client' }).success).toBe(false);
    expect(customerInput.safeParse({ email: 'client@example.com', name: '  ' }).success).toBe(
      false
    );
  });
});

describe('parseStripeApiBase', () => {
  it('accepts stripe-mock on loopback', () => {
    expect(parseStripeApiBase('http://localhost:12111')).toEqual({
      host: 'localhost',
      port: 12111,
      protocol: 'http',
    });
    expect(parseStripeApiBase('https://127.0.0.1:12112').protocol).toBe('https');
  });

  it.each(['https://evil.example.com', 'http://10.0.0.5:12111', 'file:///etc/passwd', 'not a url'])(
    'refuses to send the secret key to %s',
    (value) => {
      expect(() => parseStripeApiBase(value)).toThrow(/STRIPE_API_BASE_URL/);
    }
  );
});

describe('lib/services/stripe validates before calling the SDK', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('never sends a zero-cent refund', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_wolff');
    vi.resetModules();
    const { createRefund, stripe } = await import('@/lib/services/stripe');
    const create = vi.spyOn(stripe!.refunds, 'create');

    await expect(createRefund({ paymentIntentId: 'pi_123', amount: 0 })).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses to build a client for a non-loopback API origin', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_wolff');
    vi.stubEnv('STRIPE_API_BASE_URL', 'https://evil.example.com');
    vi.resetModules();
    await expect(import('@/lib/services/stripe')).rejects.toThrow(/loopback/);
  });
});
