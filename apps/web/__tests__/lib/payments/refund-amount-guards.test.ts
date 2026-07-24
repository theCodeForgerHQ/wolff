// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * An omitted amount means "refund everything". 0 and NaN are falsy too, and
 * used to be treated as omitted, turning a bad partial-refund amount into a
 * full refund.
 */
const mocks = vi.hoisted(() => ({
  createRefund: vi.fn(),
  paymentFindFirst: vi.fn(),
}));

vi.mock('@wolff/database', () => ({
  prisma: { payment: { findFirst: mocks.paymentFindFirst } },
}));

vi.mock('@/lib/services/stripe', () => ({
  isStripeEnabled: () => true,
  createRefund: mocks.createRefund,
  constructWebhookEvent: vi.fn(),
}));

vi.mock('@/lib/workspace/get-current-workspace', () => ({
  getCurrentUserWorkspace: vi
    .fn()
    .mockResolvedValue({ workspaceId: 'ws-1', userId: 'u-1', role: 'owner' }),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { refundPayment } from '@/lib/payments/actions';
import { StripeProvider } from '@/lib/providers/stripe-provider';

const INVALID_AMOUNTS = [0, -5, Number.NaN, Number.POSITIVE_INFINITY];

describe('refundPayment amount guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createRefund.mockResolvedValue({ id: 're_1', amount: 10_000, status: 'succeeded' });
    mocks.paymentFindFirst.mockResolvedValue({
      id: 'pay-1',
      invoiceId: 'inv-1',
      amount: 100,
      refundAmount: null,
      stripePaymentIntentId: 'pi_abc123',
    });
  });

  it.each(INVALID_AMOUNTS)('rejects %s instead of refunding in full', async (amount) => {
    const result = await refundPayment('pay-1', { amount });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/refund amount/i);
    expect(mocks.createRefund).not.toHaveBeenCalled();
  });

  it('sends a partial refund in cents', async () => {
    const result = await refundPayment('pay-1', { amount: 25.5 });

    expect(result).toEqual({ success: true });
    expect(mocks.createRefund).toHaveBeenCalledWith(expect.objectContaining({ amount: 2550 }));
  });

  it('refunds in full only when no amount is given', async () => {
    await refundPayment('pay-1');

    expect(mocks.createRefund).toHaveBeenCalledWith(expect.objectContaining({ amount: undefined }));
  });
});

describe('StripeProvider.refund amount guards', () => {
  const provider = new StripeProvider();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createRefund.mockResolvedValue({ id: 're_1', amount: 2550, status: 'succeeded' });
  });

  it.each(INVALID_AMOUNTS)('rejects %s instead of refunding in full', async (amount) => {
    await expect(provider.refund('pi_abc123', amount)).rejects.toThrow(/refund amount/i);
    expect(mocks.createRefund).not.toHaveBeenCalled();
  });

  it('sends a partial refund in cents', async () => {
    const result = await provider.refund('pi_abc123', 25.5);

    expect(mocks.createRefund).toHaveBeenCalledWith({ paymentIntentId: 'pi_abc123', amount: 2550 });
    expect(result).toEqual({ refundId: 're_1', amount: 25.5, status: 'succeeded' });
  });

  it('refunds in full only when no amount is given', async () => {
    await provider.refund('pi_abc123');

    expect(mocks.createRefund).toHaveBeenCalledWith({
      paymentIntentId: 'pi_abc123',
      amount: undefined,
    });
  });
});
