import { Router } from 'express';
import {
  receivablesAgeingRowSchema,
  revenueMonthlyRowSchema,
  gstOutwardSupplyRowSchema,
  pipelineStageRowSchema,
} from '@wolff/contracts';
import type { Db } from '@wolff/core/context';
import {
  getGstOutwardSupplies,
  getPipelineStageTransitions,
  getReceivablesAgeing,
  getRevenueMonthly,
} from '@wolff/core/reports';
import '../../context';
import { sendData } from '../../http';
import { requireScopes } from '../../middleware/auth';

export function reportRoutes(db: Db): Router {
  const router = Router();

  const ctxOf = (req: Express.Request) => ({
    db,
    workspaceId: req.ctx!.workspaceId,
  });

  router.get('/reports/receivables-ageing', requireScopes('reports:read'), async (req, res) => {
    const ctx = ctxOf(req);
    const rows = await getReceivablesAgeing(ctx.db, ctx.workspaceId);
    sendData(
      res,
      rows.map((r) => receivablesAgeingRowSchema.parse(r))
    );
  });

  router.get('/reports/revenue', requireScopes('reports:read'), async (req, res) => {
    const ctx = ctxOf(req);
    const rows = await getRevenueMonthly(ctx.db, ctx.workspaceId);
    sendData(
      res,
      rows.map((r) => revenueMonthlyRowSchema.parse(r))
    );
  });

  router.get('/reports/gst-summary', requireScopes('reports:read'), async (req, res) => {
    const ctx = ctxOf(req);
    const rows = await getGstOutwardSupplies(ctx.db, ctx.workspaceId);
    sendData(
      res,
      rows.map((r) => gstOutwardSupplyRowSchema.parse(r))
    );
  });

  router.get('/reports/pipeline', requireScopes('reports:read'), async (req, res) => {
    const ctx = ctxOf(req);
    const rows = await getPipelineStageTransitions(ctx.db, ctx.workspaceId);
    sendData(
      res,
      rows.map((r) => pipelineStageRowSchema.parse(r))
    );
  });

  return router;
}
