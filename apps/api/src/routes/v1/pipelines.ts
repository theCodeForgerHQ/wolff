import { Router } from 'express';
import {
  createPipelineSchema,
  idParamSchema,
  replaceStagesSchema,
  updatePipelineSchema,
} from '@wolff/contracts';
import type { Db } from '@wolff/core/context';
import {
  createPipeline,
  getPipeline,
  listPipelines,
  replaceStages,
  updatePipeline,
} from '@wolff/core/crm';
import '../../context';
import { sendData, sendError } from '../../http';
import { requireScopes } from '../../middleware/auth';

export function pipelineRoutes(db: Db): Router {
  const router = Router();

  const ctxOf = (req: Express.Request) => ({
    db,
    workspaceId: req.ctx!.workspaceId,
  });

  const notFound = (res: Parameters<typeof sendError>[0]) =>
    sendError(res, 'not_found', 'Not found');

  router.get('/pipelines', requireScopes('deals:read'), async (req, res) => {
    sendData(res, await listPipelines(ctxOf(req)));
  });

  router.post('/pipelines', requireScopes('deals:write'), async (req, res) => {
    const input = createPipelineSchema.parse(req.body);
    const pipeline = await createPipeline(ctxOf(req), input);
    sendData(res, pipeline, 201);
  });

  router.get('/pipelines/:id', requireScopes('deals:read'), async (req, res) => {
    const parsed = idParamSchema.safeParse(req.params);
    const pipeline = parsed.success ? await getPipeline(ctxOf(req), parsed.data.id) : null;
    if (!pipeline) return notFound(res);
    sendData(res, pipeline);
  });

  router.patch('/pipelines/:id', requireScopes('deals:write'), async (req, res) => {
    const parsed = idParamSchema.safeParse(req.params);
    const input = updatePipelineSchema.parse(req.body);
    if (!parsed.success) return notFound(res);

    const pipeline = await updatePipeline(ctxOf(req), parsed.data.id, input);
    if (!pipeline) return notFound(res);
    sendData(res, pipeline);
  });

  router.put('/pipelines/:id/stages', requireScopes('deals:write'), async (req, res) => {
    const parsed = idParamSchema.safeParse(req.params);
    const input = replaceStagesSchema.parse(req.body);
    if (!parsed.success) return notFound(res);

    const pipeline = await replaceStages(ctxOf(req), parsed.data.id, input.stages);
    sendData(res, pipeline);
  });

  return router;
}
