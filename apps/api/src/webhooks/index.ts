import express, { Router, type Request, type Response } from 'express';
import Stripe from 'stripe';
import type { Db } from '@wolff/core/context';
import { decrypt } from '@wolff/core/encryption';
import { recordProviderEvent } from '@wolff/core/payments';
import type { ApiConfig } from '../config';
import { sendError } from '../http';
import { verifyRazorpaySignature } from './razorpay';

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

  router.post('/razorpay/:workspaceId', async (req, res) => {
    const workspaceId = req.params.workspaceId;
    const rawBody = req.body as Buffer;
    const signature = req.get('X-Razorpay-Signature');
    const eventId = req.get('X-Razorpay-Event-Id');

    const settings = await deps.db.$unscoped.paymentSettings.findUnique({
      where: { workspaceId },
      select: { razorpayWebhookSecretEnc: true },
    });
    const secret = settings?.razorpayWebhookSecretEnc
      ? decrypt(settings.razorpayWebhookSecretEnc)
      : undefined;

    if (!secret) {
      return sendError(
        res,
        'not_configured',
        'Razorpay webhooks are not configured for this workspace'
      );
    }

    if (!signature || !eventId) {
      return sendError(res, 'validation_error', 'Missing Razorpay signature or event id');
    }

    if (!verifyRazorpaySignature(rawBody, signature, secret)) {
      return sendError(res, 'validation_error', 'Invalid Razorpay webhook signature');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return sendError(res, 'validation_error', 'Invalid JSON body');
    }

    const result = await recordProviderEvent(deps.db, {
      provider: 'razorpay',
      eventId,
      type: (payload as Record<string, unknown>).event?.toString() ?? 'unknown',
      payload,
      outbox: true,
    });
    if (result.outboxEventId) deps.onOutboxEvents?.([result.outboxEventId]);
    res.json({ received: true, ...(result.outcome === 'duplicate' ? { duplicate: true } : {}) });
  });

  return router;
}
