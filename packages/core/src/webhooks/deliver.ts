import { createHash } from 'node:crypto';
import type { Prisma } from '@wolff/database';
import type { Db } from '../context';
import { decrypt } from '../encryption';
import { writeOutboxEvent } from '../outbox';
import { checkWebhookUrl } from './ssrf';
import { signWebhookPayload, webhookHeaderNames, WEBHOOK_API_VERSION } from './signature';

/**
 * Outbound webhook delivery. A domain event from the outbox is
 * fanned out into one WebhookDelivery per subscribed endpoint, each with its
 * own job. The job posts a signed body; a failure throws so the queue retries
 * with its backoff, and the last failure is recorded against the endpoint.
 */
export const DELIVER_EVENT_TYPE = 'webhook.deliver';
export const DELIVERY_AGGREGATE = 'webhook_delivery';
export const MAX_CONSECUTIVE_FAILURES = 20;
const RESPONSE_EXCERPT = 1_000;
const TIMEOUT_MS = 10_000;

export interface WebhookTransport {
  /** Performs one POST. Must not follow redirects. */
  post(
    url: string,
    request: { headers: Record<string, string>; body: string; timeoutMs: number }
  ): Promise<{ status: number; body: string }>;
}

export interface DomainEventToFanOut {
  /** The outbox event id. It is the `Event-Id` receivers see, on every attempt. */
  id: string;
  workspaceId: string;
  type: string;
  payload: Prisma.JsonValue;
  createdAt: Date;
}

/** A delivery id that is the same every time this event meets this endpoint. */
function deliveryIdFor(eventId: string, endpointId: string): string {
  const hex = createHash('sha256').update(`${eventId}:${endpointId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Creates the deliveries for one domain event and queues a job for each.
 * Running it twice for the same event creates nothing the second time.
 * Returns the ids of the deliveries it created.
 */
export async function fanOutDomainEvent(db: Db, event: DomainEventToFanOut): Promise<string[]> {
  return db.$transaction(async (tx) => {
    const endpoints = await tx.webhookEndpoint.findMany({
      where: {
        workspaceId: event.workspaceId,
        isActive: true,
        disabledAt: null,
        events: { has: event.type },
      },
      select: { id: true, apiVersion: true },
    });

    const created: string[] = [];
    for (const endpoint of endpoints) {
      const id = deliveryIdFor(event.id, endpoint.id);
      const inserted = await tx.webhookDelivery.createMany({
        data: {
          id,
          endpointId: endpoint.id,
          workspaceId: event.workspaceId,
          eventType: event.type,
          payload: {
            id: event.id,
            type: event.type,
            apiVersion: endpoint.apiVersion,
            payload: event.payload,
            timestamp: event.createdAt.toISOString(),
          },
        },
        skipDuplicates: true,
      });
      if (inserted.count === 0) continue;
      await writeOutboxEvent(tx, {
        workspaceId: event.workspaceId,
        type: DELIVER_EVENT_TYPE,
        aggregateType: DELIVERY_AGGREGATE,
        aggregateId: id,
        payload: { deliveryId: id, workspaceId: event.workspaceId },
      });
      created.push(id);
    }
    return created;
  });
}

export class WebhookDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookDeliveryError';
  }
}

export interface DeliveryJob {
  deliveryId: string;
  workspaceId: string;
}

export interface DeliveryDeps {
  transport: WebhookTransport;
  requireHttps: boolean;
  now?: Date;
}

/**
 * Makes one delivery attempt. Returns `skipped` when there is nothing to do
 * (already delivered, endpoint gone or disabled, or the job names the wrong
 * workspace). Throws WebhookDeliveryError when the attempt failed.
 */
export async function deliverWebhook(
  db: Db,
  job: DeliveryJob,
  deps: DeliveryDeps
): Promise<'delivered' | 'skipped'> {
  const delivery = await db.webhookDelivery.findFirst({
    where: { id: job.deliveryId, workspaceId: job.workspaceId },
    include: { endpoint: true },
  });
  if (!delivery || delivery.status === 'delivered') return 'skipped';
  const { endpoint } = delivery;
  if (!endpoint.isActive || endpoint.disabledAt) return 'skipped';

  const attempt = async (outcome: { statusCode?: number; response: string }) =>
    db.webhookDelivery.updateMany({
      where: { id: delivery.id, workspaceId: job.workspaceId },
      data: { attempts: { increment: 1 }, ...outcome },
    });

  // The URL was checked when it was saved; check again, it may have been
  // saved before the rule existed. The transport checks the resolved address.
  const problem = checkWebhookUrl(endpoint.url, { requireHttps: deps.requireHttps });
  if (problem) {
    await attempt({ response: `Error: ${problem}` });
    throw new WebhookDeliveryError(problem);
  }

  const body = JSON.stringify(delivery.payload);
  const stored = (delivery.payload ?? {}) as { id?: string; apiVersion?: string };
  const signature = signWebhookPayload(decrypt(endpoint.secret), body, deps.now);

  let result: { status: number; body: string };
  try {
    result = await deps.transport.post(endpoint.url, {
      timeoutMs: TIMEOUT_MS,
      body,
      headers: {
        'Content-Type': 'application/json',
        [webhookHeaderNames.signature]: signature,
        [webhookHeaderNames.eventId]: stored.id ?? delivery.id,
        [webhookHeaderNames.apiVersion]: stored.apiVersion ?? WEBHOOK_API_VERSION,
        // Header the pre-API deliveries carried; kept so existing receivers
        // that route on it keep working.
        'X-Webhook-Event': delivery.eventType,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    await attempt({ response: `Error: ${message}`.slice(0, RESPONSE_EXCERPT) });
    throw new WebhookDeliveryError(message);
  }

  const response = result.body.slice(0, RESPONSE_EXCERPT);
  if (result.status < 200 || result.status >= 300) {
    await attempt({ statusCode: result.status, response });
    throw new WebhookDeliveryError(`Endpoint answered ${result.status}`);
  }

  await db.$transaction([
    db.webhookDelivery.updateMany({
      where: { id: delivery.id, workspaceId: job.workspaceId },
      data: {
        status: 'delivered',
        statusCode: result.status,
        response,
        attempts: { increment: 1 },
        nextRetry: null,
      },
    }),
    db.webhookEndpoint.updateMany({
      where: { id: endpoint.id, workspaceId: job.workspaceId },
      data: { failureCount: 0 },
    }),
  ]);
  return 'delivered';
}

/**
 * Called when a delivery has used all its attempts. Counts it against the
 * endpoint; the 20th in a row disables the endpoint and notifies the
 * workspace owner. A success in between resets the count.
 */
export async function recordDeliveryExhausted(db: Db, job: DeliveryJob): Promise<void> {
  await db.$transaction(async (tx) => {
    const delivery = await tx.webhookDelivery.findFirst({
      where: { id: job.deliveryId, workspaceId: job.workspaceId },
      select: { id: true, endpointId: true, status: true },
    });
    if (!delivery || delivery.status !== 'pending') return;

    await tx.webhookDelivery.updateMany({
      where: { id: delivery.id, workspaceId: job.workspaceId },
      data: { status: 'failed', nextRetry: null },
    });
    const [endpoint] = await tx.webhookEndpoint.updateManyAndReturn({
      where: { id: delivery.endpointId, workspaceId: job.workspaceId },
      data: { failureCount: { increment: 1 } },
      select: { id: true, url: true, failureCount: true, disabledAt: true },
    });
    if (!endpoint || endpoint.disabledAt || endpoint.failureCount < MAX_CONSECUTIVE_FAILURES) {
      return;
    }

    await tx.webhookEndpoint.updateMany({
      where: { id: endpoint.id, workspaceId: job.workspaceId },
      data: { isActive: false, disabledAt: new Date() },
    });
    const workspace = await tx.workspace.findUnique({
      where: { id: job.workspaceId },
      select: { ownerId: true },
    });
    if (!workspace?.ownerId) return;
    await tx.notification.create({
      data: {
        userId: workspace.ownerId,
        workspaceId: job.workspaceId,
        type: 'webhook_endpoint_disabled',
        title: 'A webhook endpoint was disabled',
        message: `${endpoint.url} failed ${MAX_CONSECUTIVE_FAILURES} deliveries in a row and was disabled.`,
        link: '/settings/webhooks',
      },
    });
  });
}
