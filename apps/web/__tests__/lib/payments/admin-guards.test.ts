// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Payment settings decide where customer money goes (the Razorpay keys), and
 * refunds move money back out, so both need an admin. A member or viewer
 * used to be able to call them.
 */
const mocks = vi.hoisted(() => ({
  workspace: vi.fn(),
  createRefund: vi.fn(),
  createAccountOnboardingLink: vi.fn(),
  createConnectAccount: vi.fn(),
  paymentFindFirst: vi.fn(),
  paymentSettingsUpsert: vi.fn(),
  paymentSettingsFindUnique: vi.fn(),
}));

vi.mock('@wolff/database', () => ({
  prisma: {
    payment: { findFirst: mocks.paymentFindFirst, update: vi.fn() },
    paymentSettings: {
      upsert: mocks.paymentSettingsUpsert,
      findUnique: mocks.paymentSettingsFindUnique,
      update: vi.fn(),
    },
    invoice: { update: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('@/lib/services/stripe', () => ({
  isStripeEnabled: () => true,
  createRefund: mocks.createRefund,
  createAccountOnboardingLink: mocks.createAccountOnboardingLink,
  createConnectAccount: mocks.createConnectAccount,
  retrieveConnectAccount: vi.fn(),
  constructWebhookEvent: vi.fn(),
}));

vi.mock('@/lib/workspace/get-current-workspace', () => ({
  getCurrentUserWorkspace: mocks.workspace,
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import {
  createStripeOnboardingLink,
  refundPayment,
  updatePaymentSettings,
} from '@/lib/payments/actions';

const CALLS: [string, () => Promise<{ success: boolean; error?: string }>][] = [
  [
    'updatePaymentSettings',
    () =>
      updatePaymentSettings({
        activeProviders: ['razorpay'],
        razorpayKeyId: 'rzp_test_attacker',
        razorpayKeySecret: 'attacker-secret',
      }),
  ],
  ['refundPayment', () => refundPayment('pay-1')],
  ['createStripeOnboardingLink', () => createStripeOnboardingLink()],
];

describe('payment actions need an admin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.paymentFindFirst.mockResolvedValue({
      id: 'pay-1',
      invoiceId: 'inv-1',
      amount: 100,
      refundAmount: null,
      stripePaymentIntentId: 'pi_abc123',
    });
    mocks.createRefund.mockResolvedValue({ id: 're_1', amount: 10_000, status: 'succeeded' });
  });

  describe.each(['member', 'viewer'])('as %s', (role) => {
    it.each(CALLS)('%s is refused and touches nothing', async (_name, call) => {
      mocks.workspace.mockResolvedValue({ workspaceId: 'ws-1', userId: 'u-1', role });
      const result = await call();
      expect(result).toEqual({ success: false, error: expect.stringMatching(/admin/i) });
      expect(mocks.paymentSettingsUpsert).not.toHaveBeenCalled();
      expect(mocks.paymentFindFirst).not.toHaveBeenCalled();
      expect(mocks.createRefund).not.toHaveBeenCalled();
      expect(mocks.createConnectAccount).not.toHaveBeenCalled();
      expect(mocks.createAccountOnboardingLink).not.toHaveBeenCalled();
    });
  });

  it('lets an admin save payment settings', async () => {
    mocks.workspace.mockResolvedValue({ workspaceId: 'ws-1', userId: 'u-1', role: 'admin' });
    mocks.paymentSettingsUpsert.mockResolvedValue({});
    const result = await updatePaymentSettings({ passProcessingFees: true });
    expect(result.success).toBe(true);
    expect(mocks.paymentSettingsUpsert).toHaveBeenCalled();
  });
});
