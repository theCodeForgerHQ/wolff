import { randomBytes, randomUUID } from 'node:crypto';
import { isWebhookEventType } from '@wolff/contracts';
import type { CoreContext } from '../context';
import { encrypt } from '../encryption';
import { CoreError } from '../errors';
import { writeOutboxEvent } from '../outbox';
import { afterCursor, toCursorPage } from '../pagination';
import { checkWebhookUrl } from './ssrf';
import { WEBHOOK_API_VERSION } from './signature';
import { DELIVER_EVENT_TYPE, DELIVERY_AGGREGATE } from './deliver';

export interface WebhookEndpointView {
  id: string;
  name: string;
  url: string;
  events: string[];
  isActive: boolean;
  apiVersion: string;
  failureCount: number;
  disabledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const VIEW = {
  id: true,
  name: true,
  url: true,
  events: true,
  isActive: true,
  apiVersion: true,
  failureCount: true,
  disabledAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface UrlPolicy {
  /** https only. On in production; off lets local development use http. */
  requireHttps: boolean;
}

export const defaultUrlPolicy = (): UrlPolicy => ({
  requireHttps: process.env.NODE_ENV === 'production',
});

/** Creates an endpoint. The returned `secret` is shown once and never again. */
export async function createWebhookEndpoint(
  ctx: CoreContext,
  input: { url: string; events: string[]; name?: string },
  policy: UrlPolicy = defaultUrlPolicy()
): Promise<WebhookEndpointView & { secret: string }> {
  const problem = checkWebhookUrl(input.url, policy);
  if (problem) throw new CoreError('validation_error', problem, { url: [problem] });

  const events = [...new Set(input.events.filter(isWebhookEventType))];
  if (events.length === 0) {
    const message = 'At least one valid event type is required';
    throw new CoreError('validation_error', message, { events: [message] });
  }

  const secret = `whsec_${randomBytes(24).toString('hex')}`;
  const endpoint = await ctx.db.webhookEndpoint.create({
    data: {
      workspaceId: ctx.workspaceId,
      name: input.name?.trim() ?? '',
      url: input.url,
      secret: encrypt(secret),
      events,
      apiVersion: WEBHOOK_API_VERSION,
    },
    select: VIEW,
  });
  return { ...endpoint, secret };
}

export async function listWebhookEndpoints(ctx: CoreContext): Promise<WebhookEndpointView[]> {
  return ctx.db.webhookEndpoint.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: { createdAt: 'desc' },
    select: VIEW,
  });
}

/** False when the endpoint does not exist in this workspace. */
export async function deleteWebhookEndpoint(ctx: CoreContext, id: string): Promise<boolean> {
  const result = await ctx.db.webhookEndpoint.deleteMany({
    where: { id, workspaceId: ctx.workspaceId },
  });
  return result.count === 1;
}

export interface WebhookDeliveryView {
  id: string;
  eventType: string;
  status: string;
  statusCode: number | null;
  attempts: number;
  nextRetry: Date | null;
  createdAt: Date;
}

/** Null when the endpoint does not exist in this workspace. */
export async function listWebhookDeliveries(
  ctx: CoreContext,
  endpointId: string,
  query: { limit: number; cursor?: string }
) {
  const endpoint = await ctx.db.webhookEndpoint.findFirst({
    where: { id: endpointId, workspaceId: ctx.workspaceId },
    select: { id: true },
  });
  if (!endpoint) return null;

  const rows: WebhookDeliveryView[] = await ctx.db.webhookDelivery.findMany({
    where: { workspaceId: ctx.workspaceId, endpointId, ...afterCursor(query.cursor) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    select: {
      id: true,
      eventType: true,
      status: true,
      statusCode: true,
      attempts: true,
      nextRetry: true,
      createdAt: true,
    },
  });
  return toCursorPage(rows, query.limit);
}

/** Queues a delivery again. False when it does not exist in this workspace. */
export async function retryWebhookDelivery(ctx: CoreContext, deliveryId: string): Promise<boolean> {
  return ctx.db.$transaction(async (tx) => {
    const updated = await tx.webhookDelivery.updateMany({
      where: { id: deliveryId, workspaceId: ctx.workspaceId },
      data: { status: 'pending', nextRetry: null },
    });
    if (updated.count === 0) return false;
    await writeOutboxEvent(tx, {
      workspaceId: ctx.workspaceId,
      type: DELIVER_EVENT_TYPE,
      aggregateType: DELIVERY_AGGREGATE,
      aggregateId: deliveryId,
      payload: { deliveryId, workspaceId: ctx.workspaceId },
    });
    return true;
  });
}

export const TEST_EVENT_TYPE = 'webhook.test';

/**
 * Queues a test delivery to one endpoint, whatever it is subscribed to.
 * Returns the delivery id, or null when the endpoint does not exist in this
 * workspace.
 */
export async function sendTestWebhook(
  ctx: CoreContext,
  endpointId: string
): Promise<string | null> {
  return ctx.db.$transaction(async (tx) => {
    const endpoint = await tx.webhookEndpoint.findFirst({
      where: { id: endpointId, workspaceId: ctx.workspaceId },
      select: { id: true, apiVersion: true },
    });
    if (!endpoint) return null;

    const eventId = randomUUID();
    const delivery = await tx.webhookDelivery.create({
      data: {
        endpointId: endpoint.id,
        workspaceId: ctx.workspaceId,
        eventType: TEST_EVENT_TYPE,
        payload: {
          id: eventId,
          type: TEST_EVENT_TYPE,
          apiVersion: endpoint.apiVersion,
          payload: { message: 'This is a test event.' },
          timestamp: new Date().toISOString(),
        },
      },
      select: { id: true },
    });
    await writeOutboxEvent(tx, {
      workspaceId: ctx.workspaceId,
      type: DELIVER_EVENT_TYPE,
      aggregateType: DELIVERY_AGGREGATE,
      aggregateId: delivery.id,
      payload: { deliveryId: delivery.id, workspaceId: ctx.workspaceId },
    });
    return delivery.id;
  });
}
