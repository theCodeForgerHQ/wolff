import { Router } from 'express';
import type { Db } from '@wolff/core/context';
import { createLead } from '@wolff/core/crm';
import { paymentLinkResponseSchema, publicLeadSchema } from '@wolff/contracts';
import { CoreError } from '@wolff/core/errors';
import '../../context';
import { sendData, sendError } from '../../http';
import {
  apiKeyRateLimit,
  authFailureRateLimit,
  requirePublishableKey,
  requireScopes,
  type RateLimitStoreFactory,
} from '../../middleware/auth';
import type { PaymentProviderClients } from '../../payments/provider';
import { defaultPaymentClients, startInvoicePayment } from '../../payments/start-payment';

export interface PublicRoutesDeps {
  db: Db;
  rateLimitStore?: RateLimitStoreFactory;
  paymentClients?: PaymentProviderClients;
  appUrl?: string;
}

export function publicRoutes(deps: PublicRoutesDeps): Router {
  const { db } = deps;
  const router = Router();
  const clients = deps.paymentClients ?? defaultPaymentClients();
  const appUrl = deps.appUrl ?? 'http://localhost:3000';

  const ctxOf = (req: Express.Request) => ({
    db,
    workspaceId: req.ctx!.workspaceId,
  });

  // Publishable keys are public by design; the failure limit still slows
  // down guessing. Distinct prefixes keep these counters apart from /v1's.
  const prefixed = deps.rateLimitStore
    ? (prefix: string) => deps.rateLimitStore!(`${prefix}public:`)
    : undefined;
  router.use(authFailureRateLimit(prefixed), requirePublishableKey(db), apiKeyRateLimit(prefixed));

  router.post('/leads', requireScopes('lead:create'), async (req, res) => {
    const input = publicLeadSchema.parse(req.body);
    try {
      await createLead(ctxOf(req), {
        name: input.name,
        email: input.email ?? null,
        phone: input.phone ?? null,
        company: input.company ?? null,
        message: input.message ?? null,
        source: 'widget',
        status: 'new',
        score: null,
        ownerId: null,
      });
    } catch (error) {
      // A visitor must not learn which emails the workspace already has, so
      // a duplicate gets the same answer as a new lead.
      if (!(error instanceof CoreError && error.code === 'conflict')) throw error;
    }
    sendData(res, { message: 'Lead submitted.' }, 201);
  });

  // The token is the invoice's portal token from the link
  // the client was emailed. It is unguessable and expires; an invoice id is
  // not accepted. The key pins the workspace, so another workspace's token
  // finds nothing.
  router.post('/invoices/:token/pay', requireScopes('invoice:pay'), async (req, res) => {
    const token = req.params.token as string;
    const invoice = await db.invoice.findFirst({
      where: {
        workspaceId: req.ctx!.workspaceId,
        accessToken: token,
        deletedAt: null,
        OR: [{ accessTokenExpiresAt: null }, { accessTokenExpiresAt: { gt: new Date() } }],
      },
      include: { client: { select: { name: true, email: true, phone: true } } },
    });
    if (!invoice) {
      sendError(res, 'not_found', 'Invoice not found');
      return;
    }

    try {
      const link = await startInvoicePayment(db, clients, invoice, { appUrl });
      sendData(res, paymentLinkResponseSchema.parse(link));
    } catch (error) {
      if (error instanceof CoreError) {
        sendError(res, error.code, error.message);
        return;
      }
      throw error;
    }
  });

  return router;
}
