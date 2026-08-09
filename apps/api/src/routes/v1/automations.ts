import { Router } from 'express';
import type { Db } from '@wolff/core/context';
import {
  approveRun,
  createAutomation,
  deleteAutomation,
  getAutomation,
  getAutomationRun,
  listAutomations,
  listAutomationRuns,
  updateAutomation,
} from '@wolff/core/automations';
import {
  createAutomationSchema,
  updateAutomationSchema,
  type AutomationTrigger,
} from '@wolff/contracts';
import '../../context';
import { sendData, sendError } from '../../http';
import { requireScopes } from '../../middleware/auth';

export function automationRoutes(db: Db): Router {
  const router = Router();
  const ctxOf = (req: Express.Request) => ({ db, workspaceId: req.ctx!.workspaceId });

  router.get('/', requireScopes('automations:read'), async (req, res, next) => {
    try {
      const page = await listAutomations(ctxOf(req), {
        limit: Math.min(Number(req.query.limit) || 20, 100),
        cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
        filters: {
          ...(typeof req.query.trigger === 'string' && {
            trigger: req.query.trigger as AutomationTrigger,
          }),
          ...(req.query.isActive === 'true'
            ? { isActive: true }
            : req.query.isActive === 'false'
              ? { isActive: false }
              : undefined),
        },
      });
      sendData(res, page.data, 200, page.meta);
    } catch (error) {
      next(error);
    }
  });

  router.post('/', requireScopes('automations:write'), async (req, res, next) => {
    try {
      const input = createAutomationSchema.parse(req.body);
      const automation = await createAutomation(ctxOf(req), input);
      sendData(res, automation, 201);
    } catch (error) {
      next(error);
    }
  });

  router.get('/runs', requireScopes('automations:read'), async (req, res, next) => {
    try {
      const page = await listAutomationRuns(ctxOf(req), {
        limit: Math.min(Number(req.query.limit) || 20, 100),
        cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
        filters: {
          ...(typeof req.query.status === 'string' && { status: req.query.status as any }),
          ...(typeof req.query.automationId === 'string' && {
            automationId: req.query.automationId,
          }),
        },
      });
      sendData(res, page.data, 200, page.meta);
    } catch (error) {
      next(error);
    }
  });

  router.get('/runs/:id', requireScopes('automations:read'), async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const run = await getAutomationRun(ctxOf(req), id);
      if (!run) {
        sendError(res, 'not_found', 'Run not found');
        return;
      }
      sendData(res, run);
    } catch (error) {
      next(error);
    }
  });

  // An API key has no person behind it, so core refuses its decisions with
  // 403 insufficient_scope (approvals are decided in the app).
  // The routes stay so that the refusal is explicit and documented.
  router.post('/runs/:id/approve', requireScopes('automations:write'), async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const run = await approveRun(ctxOf(req), id, true);
      if (!run) {
        sendError(res, 'not_found', 'Run not found or not waiting for approval');
        return;
      }
      sendData(res, run);
    } catch (error) {
      next(error);
    }
  });

  router.post('/runs/:id/reject', requireScopes('automations:write'), async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const run = await approveRun(ctxOf(req), id, false);
      if (!run) {
        sendError(res, 'not_found', 'Run not found or not waiting for approval');
        return;
      }
      sendData(res, run);
    } catch (error) {
      next(error);
    }
  });

  router.get('/:id', requireScopes('automations:read'), async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const automation = await getAutomation(ctxOf(req), id);
      if (!automation) {
        sendError(res, 'not_found', 'Automation not found');
        return;
      }
      sendData(res, automation);
    } catch (error) {
      next(error);
    }
  });

  router.patch('/:id', requireScopes('automations:write'), async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const input = updateAutomationSchema.parse(req.body);
      const automation = await updateAutomation(ctxOf(req), id, input);
      if (!automation) {
        sendError(res, 'not_found', 'Automation not found');
        return;
      }
      sendData(res, automation);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:id', requireScopes('automations:write'), async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const automation = await deleteAutomation(ctxOf(req), id);
      if (!automation) {
        sendError(res, 'not_found', 'Automation not found');
        return;
      }
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
