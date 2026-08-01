import express, { Router, type Request, type Response } from 'express';
import Stripe from 'stripe';
import type { Db } from '@wolff/core/context';
import { recordProviderEvent } from '@wolff/core/payments';
import type { ApiConfig } from '../config';
import { sendError } from '../http';

/**
 * Inbound provider webhooks. Each handler verifies the signature
 * over the bytes that arrived, stores the event together with its reconcile
 * job in one transaction, and answers 200. Nothing is applied here; the
 * `payments.reconcile` job does that, so an acknowledged event is never lost
 * and a slow reconcile never makes the provider time out.
 *
 * Stripe has two endpoints with two secrets: platform events, and events
 * from connected accounts (`event.account` names the account).
 */
export interface WebhookDeps {
  db: Db;
  config: ApiConfig;
  /** Told about outbox events written by a request, after it committed. */
  onOutboxEvents?: (ids: string[]) => void;
}

const RAW_LIMIT = '1mb';

// constructEvent only computes an HMAC; the key is never sent anywhere.
const stripe = new Stripe('sk_unused_signature_verification_only');

export function webhookRoutes(deps: WebhookDeps): Router {
  const router = Router();
  // The signature covers the exact bytes, so the body must not be parsed first.
  router.use(express.raw({ type: '*/*', limit: RAW_LIMIT }));

  const stripeHandler = (secret: string | undefined) => async (req: Request, res: Response) => {
    if (!secret) {
      return sendError(res, 'not_configured', 'This webhook endpoint is not configured');
    }

    let event: Stripe.Event;
    try {
      // Default tolerance: a signature older than 300 seconds is refused.
      event = stripe.webhooks.constructEvent(
        req.body as Buffer,
        req.get('stripe-signature') ?? '',
        secret
      );
    } catch {
      return sendError(res, 'validation_error', 'Invalid webhook signature');
    }

    const result = await recordProviderEvent(deps.db, {
      provider: 'stripe',
      eventId: event.id,
      type: event.type,
      payload: event,
      outbox: true,
    });
    if (result.outboxEventId) deps.onOutboxEvents?.([result.outboxEventId]);
    res.json({ received: true, ...(result.outcome === 'duplicate' ? { duplicate: true } : {}) });
  };

  router.post('/stripe', stripeHandler(deps.config.STRIPE_WEBHOOK_SECRET));
  router.post('/stripe/connect', stripeHandler(deps.config.STRIPE_CONNECT_WEBHOOK_SECRET));

  // Razorpay-ready: the route and the signature check exist. Workspaces
  // cannot store a Razorpay webhook secret until Phase 3 adds the columns, so
  // there is nothing to verify against yet.
  router.post('/razorpay/:workspaceId', (_req, res) => {
    sendError(res, 'not_configured', 'Razorpay webhooks are not configured');
  });

  return router;
}
