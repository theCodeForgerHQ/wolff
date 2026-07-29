import { z } from './zod';
import { WEBHOOK_EVENT_TYPES } from './webhook-events';

/** Request and response shapes of the webhook endpoint routes. */
export const webhookEventTypeSchema = z.enum(WEBHOOK_EVENT_TYPES).openapi('WebhookEventType');

export const createWebhookEndpointSchema = z
  .object({
    url: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .openapi({ example: 'https://example.com/hooks/billing' }),
    events: z.array(webhookEventTypeSchema).min(1).max(WEBHOOK_EVENT_TYPES.length),
    name: z.string().trim().max(200).optional(),
  })
  .strict()
  .openapi('CreateWebhookEndpoint');

export type CreateWebhookEndpointInput = z.infer<typeof createWebhookEndpointSchema>;

export const webhookEndpointSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    url: z.string(),
    events: z.array(z.string()),
    isActive: z.boolean(),
    apiVersion: z.string().openapi({ example: '2026-10' }),
    failureCount: z.number().int(),
    disabledAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi('WebhookEndpoint');

export const createdWebhookEndpointSchema = webhookEndpointSchema
  .extend({
    secret: z.string().openapi({
      description: 'The signing secret. Returned once, on creation, and never again.',
      example: 'whsec_3f1c…',
    }),
  })
  .openapi('CreatedWebhookEndpoint');

export const webhookDeliverySchema = z
  .object({
    id: z.string(),
    eventType: z.string(),
    status: z.enum(['pending', 'delivered', 'failed']),
    statusCode: z.number().int().nullable(),
    attempts: z.number().int(),
    nextRetry: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi('WebhookDelivery');

export const queuedDeliverySchema = z
  .object({ deliveryId: z.string(), status: z.literal('queued') })
  .openapi('QueuedDelivery');

export const deletedSchema = z
  .object({ id: z.string(), deleted: z.literal(true) })
  .openapi('Deleted');

export const idParamSchema = z.object({ id: z.string().uuid() });
