import { Router } from 'express';
import {
  bulkLeadActionSchema,
  convertLeadSchema,
  createLeadSchema,
  idParamSchema,
  importLeadsSchema,
  importLeadsResultSchema,
  leadListQuerySchema,
  updateLeadSchema,
} from '@wolff/contracts';
import type { Db } from '@wolff/core/context';
import {
  bulkLeads,
  convertLead,
  createLead,
  deleteLead,
  getLead,
  importLeads,
  listLeads,
  updateLead,
} from '@wolff/core/crm';
import '../../context';
import { sendData, sendError } from '../../http';
import { requireScopes } from '../../middleware/auth';

export function leadRoutes(db: Db): Router {
  const router = Router();

  const ctxOf = (req: Express.Request) => ({
    db,
    workspaceId: req.ctx!.workspaceId,
  });

  const notFound = (res: Parameters<typeof sendError>[0]) =>
    sendError(res, 'not_found', 'Not found');

  router.get('/leads', requireScopes('leads:read'), async (req, res) => {
    const query = leadListQuerySchema.parse(req.query);
    const page = await listLeads(ctxOf(req), {
      limit: query.limit,
      cursor: query.cursor,
      filters: {
        status: query.status,
        source: query.source,
        ownerId: query.ownerId,
        q: query.q,
      },
    });
    sendData(res, page.data, 200, page.meta);
  });

  router.post('/leads', requireScopes('leads:write'), async (req, res) => {
    const input = createLeadSchema.parse(req.body);
    const lead = await createLead(ctxOf(req), {
      ...input,
      email: input.email ?? null,
      phone: input.phone ?? null,
      company: input.company ?? null,
      score: input.score ?? null,
      message: input.message ?? null,
      ownerId: input.ownerId ?? null,
    });
    sendData(res, lead, 201);
  });

  router.get('/leads/:id', requireScopes('leads:read'), async (req, res) => {
    const parsed = idParamSchema.safeParse(req.params);
    const lead = parsed.success ? await getLead(ctxOf(req), parsed.data.id) : null;
    if (!lead) return notFound(res);
    sendData(res, lead);
  });

  router.patch('/leads/:id', requireScopes('leads:write'), async (req, res) => {
    const parsed = idParamSchema.safeParse(req.params);
    const input = updateLeadSchema.parse(req.body);
    if (!parsed.success) return notFound(res);

    const lead = await updateLead(ctxOf(req), parsed.data.id, {
      ...input,
      email: input.email === '' ? null : input.email,
      phone: input.phone === '' ? null : input.phone,
      company: input.company === '' ? null : input.company,
      message: input.message === '' ? null : input.message,
    });
    if (!lead) return notFound(res);
    sendData(res, lead);
  });

  router.delete('/leads/:id', requireScopes('leads:write'), async (req, res) => {
    const parsed = idParamSchema.safeParse(req.params);
    if (!parsed.success || !(await deleteLead(ctxOf(req), parsed.data.id))) {
      return notFound(res);
    }
    sendData(res, { id: parsed.data.id, deleted: true });
  });

  router.post('/leads/bulk', requireScopes('leads:write'), async (req, res) => {
    const input = bulkLeadActionSchema.parse(req.body);
    const result = await bulkLeads(ctxOf(req), {
      ids: input.ids,
      action: input.action,
      value: input.value,
    });
    sendData(res, result);
  });

  router.post('/leads/import', requireScopes('leads:write'), async (req, res) => {
    const input = importLeadsSchema.parse(req.body);
    const result = await importLeads(ctxOf(req), {
      leads: input.leads.map((row) => ({
        ...row,
        email: row.email ?? null,
        phone: row.phone ?? null,
        company: row.company ?? null,
        score: row.score ?? null,
        message: row.message ?? null,
        ownerId: row.ownerId ?? null,
      })),
      dedupeBy: input.dedupeBy,
    });
    sendData(res, importLeadsResultSchema.parse(result), 201);
  });

  router.post(
    '/leads/:id/convert',
    requireScopes('leads:write', 'deals:write'),
    async (req, res) => {
      const parsed = idParamSchema.safeParse(req.params);
      const input = convertLeadSchema.parse(req.body);
      if (!parsed.success) return notFound(res);

      try {
        const result = await convertLead(ctxOf(req), { leadId: parsed.data.id, ...input });
        sendData(res, result, 201);
      } catch (error) {
        if (error instanceof Error && error.message === 'Lead not found') {
          return notFound(res);
        }
        throw error;
      }
    }
  );

  return router;
}
