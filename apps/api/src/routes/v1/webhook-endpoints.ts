import { Router } from 'express';
import { createWebhookEndpointSchema, cursorQuerySchema, idParamSchema } from '@wolff/contracts';
import type { CoreContext, Db } from '@wolff/core/context';
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  listWebhookDeliveries,
  listWebhookEndpoints,
  retryWebhookDelivery,
  sendTestWebhook,
  type UrlPolicy,
} from '@wolff/core/webhooks';
import '../../context';
import { sendData, sendError } from '../../http';
import { requireScopes } from '../../middleware/auth';

/**
 * Webhook endpoint management, scope `webhooks:manage`.
 * An id that belongs to another workspace, or that is not an id at all, is
 * answered with the same 404 as one that does not exist.
 */
export function webhookEndpointRoutes(db: Db, policy: UrlPolicy): Router {
  const router = Router();

  const ctxOf = (req: Express.Request): CoreContext => ({ db, workspaceId: req.ctx!.workspaceId });
  const idOf = (params: unknown): string | null => {
    const parsed = idParamSchema.safeParse(params);
    return parsed.success ? parsed.data.id : null;
  };
  const notFound = (res: Parameters<typeof sendError>[0]) =>
    sendError(res, 'not_found', 'Not found');

  router.get('/webhook-endpoints', requireScopes('webhooks:manage'), async (req, res) => {
    sendData(res, await listWebhookEndpoints(ctxOf(req)));
  });

  router.post('/webhook-endpoints', requireScopes('webhooks:manage'), async (req, res) => {
    const input = createWebhookEndpointSchema.parse(req.body);
    sendData(res, await createWebhookEndpoint(ctxOf(req), input, policy), 201);
  });

  router.delete('/webhook-endpoints/:id', requireScopes('webhooks:manage'), async (req, res) => {
    const id = idOf(req.params);
    if (!id || !(await deleteWebhookEndpoint(ctxOf(req), id))) return notFound(res);
    sendData(res, { id, deleted: true });
  });

  router.post('/webhook-endpoints/:id/test', requireScopes('webhooks:manage'), async (req, res) => {
    const id = idOf(req.params);
    const deliveryId = id ? await sendTestWebhook(ctxOf(req), id) : null;
    if (!deliveryId) return notFound(res);
    sendData(res, { deliveryId, status: 'queued' }, 202);
  });

  router.get(
    '/webhook-endpoints/:id/deliveries',
    requireScopes('webhooks:manage'),
    async (req, res) => {
      const id = idOf(req.params);
      const query = cursorQuerySchema.parse(req.query);
      const page = id ? await listWebhookDeliveries(ctxOf(req), id, query) : null;
      if (!page) return notFound(res);
      sendData(res, page.data, 200, page.meta);
    }
  );

  router.post(
    '/webhook-deliveries/:id/retry',
    requireScopes('webhooks:manage'),
    async (req, res) => {
      const id = idOf(req.params);
      if (!id || !(await retryWebhookDelivery(ctxOf(req), id))) return notFound(res);
      sendData(res, { deliveryId: id, status: 'queued' }, 202);
    }
  );

  return router;
}
