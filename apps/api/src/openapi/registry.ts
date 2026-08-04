import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  apiErrorSchema,
  bulkLeadActionSchema,
  convertLeadSchema,
  convertedLeadSchema,
  createDealSchema,
  createLeadSchema,
  createPipelineSchema,
  createWebhookEndpointSchema,
  createdWebhookEndpointSchema,
  cursorEnvelope,
  cursorQuerySchema,
  dealListQuerySchema,
  dealSchema,
  deletedSchema,
  errorEnvelopeSchema,
  leadListQuerySchema,
  leadSchema,
  moveDealSchema,
  pipelineSchema,
  queuedDeliverySchema,
  replaceStagesSchema,
  successEnvelope,
  updateDealSchema,
  updateLeadSchema,
  updatePipelineSchema,
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

registry.register('Lead', leadSchema);
registry.register('CreateLead', createLeadSchema);
registry.register('UpdateLead', updateLeadSchema);
registry.register('Pipeline', pipelineSchema);
registry.register('CreatePipeline', createPipelineSchema);
registry.register('UpdatePipeline', updatePipelineSchema);
registry.register('ReplaceStages', replaceStagesSchema);
registry.register('Deal', dealSchema);
registry.register('CreateDeal', createDealSchema);
registry.register('UpdateDeal', updateDealSchema);
registry.register('MoveDeal', moveDealSchema);
registry.register('BulkLeadAction', bulkLeadActionSchema);
registry.register('ConvertLead', convertLeadSchema);
registry.register('ConvertedLead', convertedLeadSchema);

const idParam = z.object({ id: z.string().uuid() });

const listLeads = registry.registerPath({
  method: 'get',
  path: '/v1/leads',
  tags: ['CRM'],
  summary: 'List leads',
  request: { query: leadListQuerySchema },
  responses: {
    200: {
      description: 'Cursor-paginated leads',
      content: {
        'application/json': { schema: cursorEnvelope(leadSchema).openapi('ListLeadsResponse') },
      },
    },
    401: {
      description: 'Invalid or missing API key',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
    403: {
      description: 'API key lacks the `leads:read` scope',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
  },
});

const createLead = registry.registerPath({
  method: 'post',
  path: '/v1/leads',
  tags: ['CRM'],
  summary: 'Create a lead',
  request: {
    body: { required: true, content: { 'application/json': { schema: createLeadSchema } } },
  },
  responses: {
    201: {
      description: 'Lead created',
      content: {
        'application/json': { schema: successEnvelope(leadSchema).openapi('CreateLeadResponse') },
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
      description: 'API key lacks the `leads:write` scope',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
    409: {
      description: 'A lead with this email already exists',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
  },
});

const getLead = registry.registerPath({
  method: 'get',
  path: '/v1/leads/{id}',
  tags: ['CRM'],
  summary: 'Get a lead',
  request: { params: idParam.openapi('LeadId') },
  responses: {
    200: {
      description: 'Lead',
      content: {
        'application/json': { schema: successEnvelope(leadSchema).openapi('GetLeadResponse') },
      },
    },
    401: {
      description: 'Invalid or missing API key',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
    403: {
      description: 'API key lacks the `leads:read` scope',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
    404: {
      description: 'Lead not found in this workspace',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
  },
});

const updateLead = registry.registerPath({
  method: 'patch',
  path: '/v1/leads/{id}',
  tags: ['CRM'],
  summary: 'Update a lead',
  request: {
    params: idParam.openapi('LeadId'),
    body: { required: true, content: { 'application/json': { schema: updateLeadSchema } } },
  },
  responses: {
    200: {
      description: 'Lead updated',
      content: {
        'application/json': { schema: successEnvelope(leadSchema).openapi('UpdateLeadResponse') },
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
      description: 'API key lacks the `leads:write` scope',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
    404: {
      description: 'Lead not found in this workspace',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
    409: {
      description: 'A lead with this email already exists',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
  },
});

const deleteLead = registry.registerPath({
  method: 'delete',
  path: '/v1/leads/{id}',
  tags: ['CRM'],
  summary: 'Delete a lead',
  request: { params: idParam.openapi('LeadId') },
  responses: {
    200: {
      description: 'Lead deleted',
      content: {
        'application/json': {
          schema: successEnvelope(deletedSchema).openapi('DeleteLeadResponse'),
        },
      },
    },
    401: {
      description: 'Invalid or missing API key',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
    403: {
      description: 'API key lacks the `leads:write` scope',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
    404: {
      description: 'Lead not found in this workspace',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
  },
});

const bulkLeads = registry.registerPath({
  method: 'post',
  path: '/v1/leads/bulk',
  tags: ['CRM'],
  summary: 'Bulk lead actions',
  request: {
    body: { required: true, content: { 'application/json': { schema: bulkLeadActionSchema } } },
  },
  responses: {
    200: {
      description: 'Bulk action applied',
      content: {
        'application/json': {
          schema: successEnvelope(z.object({ updated: z.number().int() })).openapi(
            'BulkLeadsResponse'
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
      description: 'API key lacks the `leads:write` scope',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
  },
});

const convertLead = registry.registerPath({
  method: 'post',
  path: '/v1/leads/{id}/convert',
  tags: ['CRM'],
  summary: 'Convert a lead to a client and deal',
  request: {
    params: idParam.openapi('LeadId'),
    body: { required: true, content: { 'application/json': { schema: convertLeadSchema } } },
  },
  responses: {
    201: {
      description: 'Lead converted',
      content: {
        'application/json': {
          schema: successEnvelope(convertedLeadSchema).openapi('ConvertLeadResponse'),
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
      description: 'API key lacks the required scopes',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
    404: {
      description: 'Lead not found in this workspace',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
  },
});

const listPipelines = registry.registerPath({
  method: 'get',
  path: '/v1/pipelines',
  tags: ['CRM'],
  summary: 'List pipelines',
  responses: {
    200: {
      description: 'Pipelines',
      content: {
        'application/json': {
          schema: successEnvelope(pipelineSchema.array()).openapi('ListPipelinesResponse'),
        },
      },
    },
    401: {
      description: 'Invalid or missing API key',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
    403: {
      description: 'API key lacks the `deals:read` scope',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
  },
});

const createPipeline = registry.registerPath({
  method: 'post',
  path: '/v1/pipelines',
  tags: ['CRM'],
  summary: 'Create a pipeline',
  request: {
    body: { required: true, content: { 'application/json': { schema: createPipelineSchema } } },
  },
  responses: {
    201: {
      description: 'Pipeline created',
      content: {
        'application/json': {
          schema: successEnvelope(pipelineSchema).openapi('CreatePipelineResponse'),
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
      description: 'API key lacks the `deals:write` scope',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
  },
});

const getPipeline = registry.registerPath({
  method: 'get',
  path: '/v1/pipelines/{id}',
  tags: ['CRM'],
  summary: 'Get a pipeline',
  request: { params: idParam.openapi('PipelineId') },
  responses: {
    200: {
      description: 'Pipeline',
      content: {
        'application/json': {
          schema: successEnvelope(pipelineSchema).openapi('GetPipelineResponse'),
        },
      },
    },
    401: {
      description: 'Invalid or missing API key',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
    403: {
      description: 'API key lacks the `deals:read` scope',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
    404: {
      description: 'Pipeline not found in this workspace',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
  },
});

const updatePipeline = registry.registerPath({
  method: 'patch',
  path: '/v1/pipelines/{id}',
  tags: ['CRM'],
  summary: 'Update a pipeline',
  request: {
    params: idParam.openapi('PipelineId'),
    body: { required: true, content: { 'application/json': { schema: updatePipelineSchema } } },
  },
  responses: {
    200: {
      description: 'Pipeline updated',
      content: {
        'application/json': {
          schema: successEnvelope(pipelineSchema).openapi('UpdatePipelineResponse'),
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
      description: 'API key lacks the `deals:write` scope',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
    404: {
      description: 'Pipeline not found in this workspace',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
  },
});

const replaceStages = registry.registerPath({
  method: 'put',
  path: '/v1/pipelines/{id}/stages',
  tags: ['CRM'],
  summary: 'Replace pipeline stages',
  request: {
    params: idParam.openapi('PipelineId'),
    body: { required: true, content: { 'application/json': { schema: replaceStagesSchema } } },
  },
  responses: {
    200: {
      description: 'Stages replaced',
      content: {
        'application/json': {
          schema: successEnvelope(pipelineSchema).openapi('ReplaceStagesResponse'),
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
      description: 'API key lacks the `deals:write` scope',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
    404: {
      description: 'Pipeline not found in this workspace',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
  },
});

const listDeals = registry.registerPath({
  method: 'get',
  path: '/v1/deals',
  tags: ['CRM'],
  summary: 'List deals',
  request: { query: dealListQuerySchema },
  responses: {
    200: {
      description: 'Cursor-paginated deals',
      content: {
        'application/json': { schema: cursorEnvelope(dealSchema).openapi('ListDealsResponse') },
      },
    },
    401: {
      description: 'Invalid or missing API key',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
    403: {
      description: 'API key lacks the `deals:read` scope',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
  },
});

const createDeal = registry.registerPath({
  method: 'post',
  path: '/v1/deals',
  tags: ['CRM'],
  summary: 'Create a deal',
  request: {
    body: { required: true, content: { 'application/json': { schema: createDealSchema } } },
  },
  responses: {
    201: {
      description: 'Deal created',
      content: {
        'application/json': {
          schema: successEnvelope(z.object({ dealId: z.string().uuid() })).openapi(
            'CreateDealResponse'
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
      description: 'API key lacks the `deals:write` scope',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
  },
});

const getDeal = registry.registerPath({
  method: 'get',
  path: '/v1/deals/{id}',
  tags: ['CRM'],
  summary: 'Get a deal',
  request: { params: idParam.openapi('DealId') },
  responses: {
    200: {
      description: 'Deal',
      content: {
        'application/json': { schema: successEnvelope(dealSchema).openapi('GetDealResponse') },
      },
    },
    401: {
      description: 'Invalid or missing API key',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
    403: {
      description: 'API key lacks the `deals:read` scope',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
    404: {
      description: 'Deal not found in this workspace',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
  },
});

const updateDeal = registry.registerPath({
  method: 'patch',
  path: '/v1/deals/{id}',
  tags: ['CRM'],
  summary: 'Update a deal',
  request: {
    params: idParam.openapi('DealId'),
    body: { required: true, content: { 'application/json': { schema: updateDealSchema } } },
  },
  responses: {
    200: {
      description: 'Deal updated',
      content: {
        'application/json': { schema: successEnvelope(dealSchema).openapi('UpdateDealResponse') },
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
      description: 'API key lacks the `deals:write` scope',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
    404: {
      description: 'Deal or stage not found in this workspace',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
  },
});

const deleteDeal = registry.registerPath({
  method: 'delete',
  path: '/v1/deals/{id}',
  tags: ['CRM'],
  summary: 'Delete a deal',
  request: { params: idParam.openapi('DealId') },
  responses: {
    200: {
      description: 'Deal deleted',
      content: {
        'application/json': {
          schema: successEnvelope(deletedSchema).openapi('DeleteDealResponse'),
        },
      },
    },
    401: {
      description: 'Invalid or missing API key',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
    403: {
      description: 'API key lacks the `deals:write` scope',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
    404: {
      description: 'Deal not found in this workspace',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
  },
});

const moveDeal = registry.registerPath({
  method: 'post',
  path: '/v1/deals/{id}/move',
  tags: ['CRM'],
  summary: 'Move a deal to a new stage',
  request: {
    params: idParam.openapi('DealId'),
    body: { required: true, content: { 'application/json': { schema: moveDealSchema } } },
  },
  responses: {
    200: {
      description: 'Deal moved',
      content: {
        'application/json': {
          schema: successEnvelope(
            z.object({
              dealId: z.string().uuid(),
              previousStageId: z.string().uuid(),
              newStageId: z.string().uuid(),
              wonAt: z.string().datetime().nullable(),
              lostAt: z.string().datetime().nullable(),
            })
          ).openapi('MoveDealResponse'),
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
      description: 'API key lacks the `deals:write` scope',
      content: { 'application/json': { schema: errorEnvelopeSchema } },
    },
    404: {
      description: 'Deal or stage not found in this workspace',
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
  listLeads,
  createLead,
  getLead,
  updateLead,
  deleteLead,
  bulkLeads,
  convertLead,
  listPipelines,
  createPipeline,
  getPipeline,
  updatePipeline,
  replaceStages,
  listDeals,
  createDeal,
  getDeal,
  updateDeal,
  deleteDeal,
  moveDeal,
};
