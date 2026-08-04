import { Router } from 'express';
import {
  createDealSchema,
  dealListQuerySchema,
  idParamSchema,
  moveDealSchema,
  updateDealSchema,
} from '@wolff/contracts';
import type { Db } from '@wolff/core/context';
import { createDeal, deleteDeal, getDeal, listDeals, moveDeal, updateDeal } from '@wolff/core/crm';
import '../../context';
import { sendData, sendError } from '../../http';
import { requireScopes } from '../../middleware/auth';

export function dealRoutes(db: Db): Router {
  const router = Router();

  const ctxOf = (req: Express.Request) => ({
    db,
    workspaceId: req.ctx!.workspaceId,
  });

  const notFound = (res: Parameters<typeof sendError>[0]) =>
    sendError(res, 'not_found', 'Not found');

  router.get('/deals', requireScopes('deals:read'), async (req, res) => {
    const query = dealListQuerySchema.parse(req.query);
    const page = await listDeals(ctxOf(req), { limit: query.limit, cursor: query.cursor });
    sendData(res, page.data, 200, page.meta);
  });

  router.post('/deals', requireScopes('deals:write'), async (req, res) => {
    const input = createDealSchema.parse(req.body);
    const result = await createDeal(ctxOf(req), {
      ...input,
      value: input.value ?? 0,
      currency: input.currency ?? 'USD',
      expectedCloseDate: input.expectedCloseDate ? new Date(input.expectedCloseDate) : undefined,
      ownerId: input.ownerId,
    });
    sendData(res, result, 201);
  });

  router.get('/deals/:id', requireScopes('deals:read'), async (req, res) => {
    const parsed = idParamSchema.safeParse(req.params);
    const deal = parsed.success ? await getDeal(ctxOf(req), parsed.data.id) : null;
    if (!deal) return notFound(res);
    sendData(res, deal);
  });

  router.patch('/deals/:id', requireScopes('deals:write'), async (req, res) => {
    const parsed = idParamSchema.safeParse(req.params);
    const input = updateDealSchema.parse(req.body);
    if (!parsed.success) return notFound(res);

    try {
      const deal = await updateDeal(ctxOf(req), parsed.data.id, {
        ...input,
        expectedCloseDate:
          input.expectedCloseDate === null
            ? null
            : input.expectedCloseDate
              ? new Date(input.expectedCloseDate)
              : undefined,
      });
      if (!deal) return notFound(res);
      sendData(res, deal);
    } catch (error) {
      if (error instanceof Error && error.message === 'Stage not found in pipeline') {
        return sendError(res, 'not_found', 'Stage not found in pipeline');
      }
      throw error;
    }
  });

  router.delete('/deals/:id', requireScopes('deals:write'), async (req, res) => {
    const parsed = idParamSchema.safeParse(req.params);
    if (!parsed.success || !(await deleteDeal(ctxOf(req), parsed.data.id))) {
      return notFound(res);
    }
    sendData(res, { id: parsed.data.id, deleted: true });
  });

  router.post('/deals/:id/move', requireScopes('deals:write'), async (req, res) => {
    const parsed = idParamSchema.safeParse(req.params);
    const input = moveDealSchema.parse(req.body);
    if (!parsed.success) return notFound(res);

    try {
      const result = await moveDeal(ctxOf(req), {
        dealId: parsed.data.id,
        stageId: input.stageId,
        position: input.position,
        lostReason: input.lostReason,
      });
      sendData(res, result);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === 'Deal not found') return notFound(res);
        if (error.message === 'Target stage not found in deal pipeline') {
          return sendError(res, 'not_found', 'Stage not found in pipeline');
        }
      }
      throw error;
    }
  });

  return router;
}
