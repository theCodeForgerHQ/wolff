import { Router } from 'express';
import { z } from 'zod';
import { createLeadSchema, moveDealSchema } from '@wolff/contracts';
import type { Db } from '@wolff/core/context';
import { createLead, moveDeal } from '@wolff/core/crm';
import { CoreError } from '@wolff/core/errors';
import { isGstWorkspace, loadGstProfile, priceGstInvoice } from '@wolff/core/invoices';
import { createDraftQuote, MAX_DRAFT_LINES } from '@wolff/core/quotes';
import type { ApiConfig } from '../config';
import { sendData, sendError } from '../http';
import { requireScopes } from '../middleware/auth';
import { requireServiceJwt, type ReplayCache } from '../middleware/service-jwt';

/**
 * `/internal/*`: calls from our own services. Only a service JWT
 * opens them. On AWS the load balancer also keeps them off the public
 * listener; on the free demo there is no private network and the signature
 * is the only protection.
 *
 * The AI service calls the write routes with a token it minted that
 * forwards the original caller's user, workspace and scopes (it cannot
 * widen them), so validation, numbering and events stay in one place.
 * The workspace always comes from the token.
 */
const id = z.string().trim().min(1).max(100);
const money = z.number().finite();

const gstComputeSchema = z
  .object({
    clientId: id,
    placeOfSupply: z
      .string()
      .regex(/^\d{2}$/)
      .optional(),
    lines: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(200),
            quantity: money.positive(),
            rate: money.nonnegative(),
            gstRate: money.min(0).max(28),
            hsnSac: z.string().trim().max(8).optional(),
            itemType: z.enum(['goods', 'services']).default('services'),
          })
          .strict()
      )
      .min(1)
      .max(MAX_DRAFT_LINES),
  })
  .strict();

const draftQuoteSchema = z
  .object({
    clientId: id,
    dealId: id.nullish(),
    title: z.string().trim().min(1).max(300),
    currency: z.string().regex(/^[A-Z]{3}$/),
    lineItems: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(200),
            description: z.string().max(2000).nullish(),
            quantity: money.positive().max(1e6),
            unit: z.string().max(50).nullish(),
            rate: money.nonnegative().max(1e10),
            hsnSac: z.string().trim().max(8).nullish(),
            gstRate: money.min(0).max(28).nullish(),
            source: z.enum(['rate_card', 'past_quote', 'new']),
            sourceRef: id.nullish(),
          })
          .strict()
      )
      .min(1)
      .max(MAX_DRAFT_LINES),
    terms: z.string().max(5000).nullish(),
    notes: z.string().max(5000).nullish(),
    assumptions: z.array(z.string().max(500)).max(20).default([]),
  })
  .strict();

export function internalRoutes(config: ApiConfig, replayCache: ReplayCache, db: Db): Router {
  const router = Router();
  router.use(
    requireServiceJwt({
      secrets: { web: config.SVC_JWT_SECRET_WEB, ai: config.SVC_JWT_SECRET_AI },
      issuers: ['web', 'ai'],
      audience: 'api',
      replayCache,
    })
  );
  const ctxOf = (req: Express.Request) => ({
    db,
    workspaceId: req.ctx!.workspaceId,
    actorId: req.ctx!.userId,
  });

  router.get('/healthz', (req, res) => {
    sendData(res, {
      status: 'ok',
      issuer: req.ctx!.keyId,
      workspaceId: req.ctx!.workspaceId,
      subject: req.ctx!.userId,
    });
  });

  // GST has one implementation: the AI agent prices its drafts here.
  router.post('/gst/compute', requireScopes('quotes:write'), async (req, res) => {
    const input = gstComputeSchema.parse(req.body);
    const workspaceId = req.ctx!.workspaceId;
    const profile = await loadGstProfile(db, workspaceId);
    if (!isGstWorkspace(profile)) {
      throw new CoreError('gst_unsupported', 'This workspace is not registered for GST');
    }
    const client = await db.client.findFirst({
      where: { id: input.clientId, workspaceId, deletedAt: null },
      select: { stateCode: true, countryCode: true, gstin: true },
    });
    if (!client) throw new CoreError('not_found', 'Client not found');
    const priced = priceGstInvoice({
      profile,
      client,
      lines: input.lines,
      placeOfSupply: input.placeOfSupply,
    });
    sendData(res, { invoice: priced.invoice, lines: priced.lines });
  });

  router.post('/quotes/draft', requireScopes('quotes:write'), async (req, res) => {
    const input = draftQuoteSchema.parse(req.body);
    sendData(res, await createDraftQuote(ctxOf(req), input), 201);
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
    sendData(res, { id: lead.id, name: lead.name, status: lead.status }, 201);
  });

  router.post('/deals/:id/move', requireScopes('deals:write'), async (req, res) => {
    const body = moveDealSchema.parse(req.body);
    try {
      sendData(res, await moveDeal(ctxOf(req), { dealId: id.parse(req.params.id), ...body }));
    } catch (error) {
      // moveDeal reports these as plain errors; the same mapping as /v1.
      if (error instanceof Error && error.message === 'Deal not found') {
        return sendError(res, 'not_found', 'Not found');
      }
      if (error instanceof Error && error.message === 'Target stage not found in deal pipeline') {
        return sendError(res, 'not_found', 'Stage not found in pipeline');
      }
      throw error;
    }
  });

  return router;
}
