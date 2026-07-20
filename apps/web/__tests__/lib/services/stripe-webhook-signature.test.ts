// @vitest-environment node
import Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Exercises the real stripe SDK (no mocks): the webhook route trusts
 * constructWebhookEvent, so a signature regression after an SDK upgrade must
 * fail here rather than in production.
 */
const SECRET = 'whsec_test_wolff_signature';

const payload = JSON.stringify({
  id: 'evt_test_1',
  object: 'event',
  type: 'payment_intent.succeeded',
  data: { object: { id: 'pi_test_1', object: 'payment_intent', metadata: { invoiceId: 'inv_1' } } },
});

async function loadService() {
  vi.resetModules();
  return import('@/lib/services/stripe');
}

describe('constructWebhookEvent with the real Stripe SDK', () => {
  beforeEach(() => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_wolff');
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('accepts a payload signed with the endpoint secret', async () => {
    const { constructWebhookEvent } = await loadService();
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });

    const event = constructWebhookEvent(payload, header);

    expect(event.id).toBe('evt_test_1');
    expect(event.type).toBe('payment_intent.succeeded');
  });

  it('rejects a payload whose body was changed after signing', async () => {
    const { constructWebhookEvent } = await loadService();
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });

    expect(() => constructWebhookEvent(payload.replace('inv_1', 'inv_2'), header)).toThrow(
      Stripe.errors.StripeSignatureVerificationError
    );
  });

  it('rejects a payload signed with a different secret', async () => {
    const { constructWebhookEvent } = await loadService();
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_other' });

    expect(() => constructWebhookEvent(payload, header)).toThrow(
      Stripe.errors.StripeSignatureVerificationError
    );
  });

  it('rejects a signature older than the tolerance window', async () => {
    const { constructWebhookEvent } = await loadService();
    const header = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: SECRET,
      timestamp: Math.floor(Date.now() / 1000) - 10 * 60,
    });

    expect(() => constructWebhookEvent(payload, header)).toThrow(
      Stripe.errors.StripeSignatureVerificationError
    );
  });

  it('pins the API version the integration was upgraded to', async () => {
    const { STRIPE_API_VERSION } = await loadService();
    expect(STRIPE_API_VERSION).toBe('2026-08-26.dahlia');
  });
});
