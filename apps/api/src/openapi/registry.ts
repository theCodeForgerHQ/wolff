import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  apiErrorSchema,
  createWebhookEndpointSchema,
  createdWebhookEndpointSchema,
  cursorEnvelope,
  cursorQuerySchema,
  deletedSchema,
  errorEnvelopeSchema,
  queuedDeliverySchema,
  successEnvelope,
  webhookDeliverySchema,
  webhookEndpointSchema,
  z,
} from '@wolff/contracts';

export const registry = new OpenAPIRegistry();

registry.register('ApiError', apiErrorSchema);
registry.register('ErrorResponse', errorEnvelopeSchema);
registry.register('WebhookEndpoint', webhookEndpointSchema);
registry.register('CreatedWebhookEndpoint', createdWebhookEndpointSchema);
registry.register('WebhookDelivery', webhookDeliverySchema);
registry.register('CreateWebhookEndpoint', createWebhookEndpointSchema);

const listWebhookEndpoints = registry.registerPath({
  method: 'get',
  path: '/v1/webhook-endpoints',
  tags: ['Webhook endpoints'],
  summary: 'List webhook endpoints',
  description: 'Returns the webhook endpoints registered for the workspace of the API key.',
  responses: {
    200: {
      description: 'List of webhook endpoints',
      content: {
        'application/json': {
          schema: successEnvelope(webhookEndpointSchema.array()).openapi(
            'ListWebhookEndpointsResponse'
          ),
        },
      },
    },
    401: {
      description: 'Invalid or missing API key',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
    403: {
      description: 'API key lacks the `webhooks:manage` scope',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
  },
});

const createWebhookEndpoint = registry.registerPath({
  method: 'post',
  path: '/v1/webhook-endpoints',
  tags: ['Webhook endpoints'],
  summary: 'Create a webhook endpoint',
  description:
    'Registers a new endpoint to receive outbound webhook events. The signing secret is returned only in this response.',
  request: {
    body: {
      description: 'Endpoint configuration',
      required: true,
      content: { 'application/json': { schema: createWebhookEndpointSchema } },
    },
  },
  responses: {
    201: {
      description: 'Endpoint created',
      content: {
        'application/json': {
          schema: successEnvelope(createdWebhookEndpointSchema).openapi(
            'CreateWebhookEndpointResponse'
          ),
        },
      },
    },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
    401: {
      description: 'Invalid or missing API key',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
    403: {
      description: 'API key lacks the `webhooks:manage` scope',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
    409: {
      description: 'Idempotency conflict or duplicate URL',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
  },
});

const deleteWebhookEndpoint = registry.registerPath({
  method: 'delete',
  path: '/v1/webhook-endpoints/{id}',
  tags: ['Webhook endpoints'],
  summary: 'Delete a webhook endpoint',
  description: 'Deletes the endpoint and stops future deliveries.',
  request: {
    params: z.object({ id: z.string().uuid() }).openapi('WebhookEndpointId'),
  },
  responses: {
    200: {
      description: 'Endpoint deleted',
      content: {
        'application/json': { schema: successEnvelope(deletedSchema).openapi('DeletedResponse') },
      },
    },
    401: {
      description: 'Invalid or missing API key',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
    403: {
      description: 'API key lacks the `webhooks:manage` scope',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
    404: {
      description: 'Endpoint not found in this workspace',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
  },
});

const sendTestWebhook = registry.registerPath({
  method: 'post',
  path: '/v1/webhook-endpoints/{id}/test',
  tags: ['Webhook endpoints'],
  summary: 'Send a test webhook',
  description: 'Queues a test event to the endpoint.',
  request: {
    params: z.object({ id: z.string().uuid() }).openapi('WebhookEndpointId'),
  },
  responses: {
    202: {
      description: 'Test delivery queued',
      content: {
        'application/json': {
          schema: successEnvelope(queuedDeliverySchema).openapi('QueuedDeliveryResponse'),
        },
      },
    },
    401: {
      description: 'Invalid or missing API key',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
    403: {
      description: 'API key lacks the `webhooks:manage` scope',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
    404: {
      description: 'Endpoint not found in this workspace',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
  },
});

const listWebhookDeliveries = registry.registerPath({
  method: 'get',
  path: '/v1/webhook-endpoints/{id}/deliveries',
  tags: ['Webhook deliveries'],
  summary: 'List webhook deliveries',
  description: 'Returns cursor-paginated delivery attempts for an endpoint.',
  request: {
    params: z.object({ id: z.string().uuid() }).openapi('WebhookEndpointId'),
    query: cursorQuerySchema,
  },
  responses: {
    200: {
      description: 'List of deliveries',
      content: {
        'application/json': {
          schema: cursorEnvelope(webhookDeliverySchema).openapi('ListWebhookDeliveriesResponse'),
        },
      },
    },
    401: {
      description: 'Invalid or missing API key',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
    403: {
      description: 'API key lacks the `webhooks:manage` scope',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
    404: {
      description: 'Endpoint not found in this workspace',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
  },
});

const retryWebhookDelivery = registry.registerPath({
  method: 'post',
  path: '/v1/webhook-deliveries/{id}/retry',
  tags: ['Webhook deliveries'],
  summary: 'Retry a webhook delivery',
  description: 'Queues a retry for a failed or exhausted delivery.',
  request: {
    params: z.object({ id: z.string().uuid() }).openapi('WebhookDeliveryId'),
  },
  responses: {
    202: {
      description: 'Retry queued',
      content: {
        'application/json': {
          schema: successEnvelope(queuedDeliverySchema).openapi('QueuedDeliveryResponse'),
        },
      },
    },
    401: {
      description: 'Invalid or missing API key',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
    403: {
      description: 'API key lacks the `webhooks:manage` scope',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
    404: {
      description: 'Delivery not found in this workspace',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
  },
});

// Keep the registered operation objects reachable for any future middleware that
// wants to attach metadata to the live routes.
export const operations = {
  listWebhookEndpoints,
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  sendTestWebhook,
  listWebhookDeliveries,
  retryWebhookDelivery,
};
