import type {
  PaymentProvider,
  CheckoutParams,
  CheckoutResult,
  WebhookResult,
  RefundResult,
} from './payment';
import {
  isStripeEnabled,
  constructWebhookEvent,
  createCheckoutSession,
  createRefund,
} from '@/lib/services/stripe';
import { toRefundMinorUnits } from '@/lib/payments/refund-amount';
import { fromMinorUnits, toMinorUnits } from '@wolff/core/payments';
import type Stripe from 'stripe';

export class StripeProvider implements PaymentProvider {
  name = 'stripe';

  isEnabled(): boolean {
    return isStripeEnabled();
  }

  async createCheckoutSession(params: CheckoutParams): Promise<CheckoutResult> {
    const session = await createCheckoutSession({
      invoiceId: params.invoiceId,
      amount: toMinorUnits(params.amount, params.currency),
      currency: params.currency,
      description: params.description,
      customerEmail: params.customerEmail,
      successUrl: params.successUrl,
      cancelUrl: params.cancelUrl,
    });

    return {
      sessionId: session.id,
      url: session.url || '',
    };
  }

  async processWebhook(request: Request): Promise<WebhookResult> {
    const body = await request.text();
    const signature = request.headers.get('stripe-signature');

    if (!signature) {
      throw new Error('Missing Stripe signature');
    }

    const event = constructWebhookEvent(body, signature);

    switch (event.type) {
      case 'payment_intent.succeeded': {
        const pi = event.data.object as Stripe.PaymentIntent;
        return {
          eventType: 'payment.succeeded',
          invoiceId: pi.metadata.invoiceId,
          paymentId: pi.id,
          amount: fromMinorUnits(pi.amount, pi.currency),
        };
      }
      case 'payment_intent.payment_failed': {
        const pi = event.data.object as Stripe.PaymentIntent;
        return {
          eventType: 'payment.failed',
          invoiceId: pi.metadata.invoiceId,
          paymentId: pi.id,
        };
      }
      default:
        return { eventType: event.type };
    }
  }

  async refund(
    paymentId: string,
    amount: number | undefined,
    currency: string
  ): Promise<RefundResult> {
    const refund = await createRefund({
      paymentIntentId: paymentId,
      amount: toRefundMinorUnits(amount, currency),
    });

    if (!refund) {
      throw new Error('Failed to create refund');
    }

    return {
      refundId: refund.id,
      amount: fromMinorUnits(refund.amount, refund.currency ?? currency),
      status: refund.status || 'pending',
    };
  }
}
