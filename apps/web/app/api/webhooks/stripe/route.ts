import { NextRequest, NextResponse } from 'next/server';
import { prisma, withTenantGuard } from '@wolff/database';
import { processProviderEvent, recordProviderEvent } from '@wolff/core/payments';
import { constructWebhookEvent, isStripeEnabled } from '@/lib/services/stripe';
import { logger } from '@/lib/logger';
import type Stripe from 'stripe';

const db = withTenantGuard(prisma);

/**
 * POST /api/webhooks/stripe: the endpoint that predates apps/api.
 *
 * While Stripe delivers every event both here and
 * to the API, both endpoints dedupe on ProviderWebhookEvent and apply the
 * event through the same core code, so it is applied once whichever endpoint
 * gets it first. This one applies it inline (no outbox job); the API queues a
 * payments.reconcile job instead.
 *
 * If applying fails the event stays `received` with the error on it and this
 * answers 500, so Stripe retries; the outbox sweeper also re-drives events
 * left `received` for more than 10 minutes. Once this endpoint has had no
 * traffic for 7 days it is disabled in Stripe and deleted (step 4).
 */
export async function POST(request: NextRequest) {
  if (!isStripeEnabled()) {
    return NextResponse.json({ error: 'Stripe not configured' }, { status: 501 });
  }

  const body = await request.text();
  const signature = request.headers.get('stripe-signature');
  if (!signature) {
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = constructWebhookEvent(body, signature);
  } catch (error) {
    logger.error({ err: error }, 'Webhook signature verification failed');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  try {
    const recorded = await recordProviderEvent(db, {
      provider: 'stripe',
      eventId: event.id,
      type: event.type,
      payload: event,
      outbox: false,
    });
    if (recorded.outcome === 'duplicate') {
      return NextResponse.json({ received: true, duplicate: true });
    }

    const outcome = await processProviderEvent(db, recorded.id);
    return NextResponse.json(
      outcome === 'already_processed' ? { received: true, duplicate: true } : { received: true }
    );
  } catch (error) {
    logger.error({ err: error, eventId: event.id }, 'Error processing Stripe webhook');
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}
