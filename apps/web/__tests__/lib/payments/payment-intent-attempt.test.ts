// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Stripe replays the stored response for an idempotency key for 24 hours.
 * A replacement PaymentIntent therefore needs a key the previous attempt
 * didn't use, or Stripe hands back the old (cancelled) intent.
 */
const mocks = vi.hoisted(() => ({
  invoiceFindFirst: vi.fn(),
  paymentFindFirst: vi.fn(),
  paymentCount: vi.fn(),
  paymentUpdate: vi.fn(),
  paymentCreate: vi.fn(),
  retrieve: vi.fn(),
  cancel: vi.fn(),
  createPaymentIntent: vi.fn(),
  getOrCreateCustomer: vi.fn(),
}));

vi.mock('@wolff/database', () => ({
  prisma: {
    invoice: { findFirst: mocks.invoiceFindFirst },
    payment: {
      findFirst: mocks.paymentFindFirst,
      count: mocks.paymentCount,
      update: mocks.paymentUpdate,
      create: mocks.paymentCreate,
    },
  },
}));

vi.mock('@/lib/services/stripe', () => ({
  retrievePaymentIntent: mocks.retrieve,
  cancelPaymentIntent: mocks.cancel,
  isStripeEnabled: () => true,
  createPaymentIntent: mocks.createPaymentIntent,
  getOrCreateCustomer: mocks.getOrCreateCustomer,
}));

vi.mock('@/lib/workspace/get-current-workspace', () => ({
  getCurrentUserWorkspace: vi.fn(),
}));

vi.mock('@/lib/services/email', () => ({ sendPaymentReceivedEmail: vi.fn() }));

import { createInvoicePaymentIntent } from '@/lib/payments/internal';
import { paymentIntentIdempotencyKey } from '@/lib/services/stripe-inputs';

const invoice = {
  id: 'inv-1',
  workspaceId: 'ws-1',
  clientId: 'client-1',
  invoiceNumber: 'INV-0001',
  status: 'sent',
  amountDue: 250,
  currency: 'USD',
  settings: {},
  client: { id: 'client-1', name: 'Client', company: null, email: 'client@wolff.test' },
  workspace: { paymentSettings: { stripeAccountId: 'acct_1', stripeOnboardingComplete: true } },
};

describe('paymentIntentIdempotencyKey', () => {
  const base = { invoiceId: 'inv-1', amount: 25_000, currency: 'usd' };

  it('is stable for the same attempt, so a double click creates one intent', () => {
    expect(paymentIntentIdempotencyKey({ ...base, attempt: 0 })).toBe(
      paymentIntentIdempotencyKey({ ...base, attempt: 0 })
    );
  });

  it('changes with the attempt, so a replacement is not a replay', () => {
    expect(paymentIntentIdempotencyKey({ ...base, attempt: 1 })).not.toBe(
      paymentIntentIdempotencyKey({ ...base, attempt: 0 })
    );
  });
});

describe('createInvoicePaymentIntent attempt numbering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invoiceFindFirst.mockResolvedValue(invoice);
    mocks.getOrCreateCustomer.mockResolvedValue({ id: 'cus_1' });
    mocks.createPaymentIntent.mockResolvedValue({ id: 'pi_new', client_secret: 'pi_new_secret' });
  });

  it('uses attempt 0 for the first intent of an invoice', async () => {
    mocks.paymentFindFirst.mockResolvedValue(null);
    mocks.paymentCount.mockResolvedValue(0);

    const result = await createInvoicePaymentIntent('inv-1', 'token');

    expect(result.success).toBe(true);
    expect(mocks.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: 'inv-1', amount: 25_000, attempt: 0 })
    );
  });

  it('uses the next attempt when replacing a cancelled intent of the same amount', async () => {
    mocks.paymentFindFirst.mockResolvedValue({ id: 'pay-1', stripePaymentIntentId: 'pi_old' });
    mocks.retrieve.mockResolvedValue({ id: 'pi_old', status: 'canceled', amount: 25_000 });
    mocks.paymentCount.mockResolvedValue(1);

    const result = await createInvoicePaymentIntent('inv-1', 'token');

    expect(result).toMatchObject({ success: true, paymentIntentId: 'pi_new' });
    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: 'pay-1' },
      data: { status: 'failed' },
    });
    expect(mocks.paymentCount).toHaveBeenCalledWith({
      where: { invoiceId: 'inv-1', stripePaymentIntentId: { not: null } },
    });
    expect(mocks.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 25_000, attempt: 1 })
    );
  });
});
