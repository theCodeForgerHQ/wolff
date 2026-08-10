import { Router } from 'express';
import {
  createPaymentLinkSchema,
  idParamSchema,
  paymentLinkResponseSchema,
} from '@wolff/contracts';
import type { Db } from '@wolff/core/context';
import { CoreError } from '@wolff/core/errors';
import '../../context';
import { sendData, sendError } from '../../http';
import { requireScopes } from '../../middleware/auth';
import { requireIdempotencyKey } from '../../middleware/idempotency';
import type { PaymentProviderClients } from '../../payments/provider';
import { defaultPaymentClients, startInvoicePayment } from '../../payments/start-payment';

export interface InvoiceRouteDeps {
  paymentClients?: PaymentProviderClients;
  appUrl?: string;
}

export function invoiceRoutes(db: Db, deps: InvoiceRouteDeps = {}): Router {
  const router = Router();

  const ctxOf = (req: Express.Request) => ({
    db,
    workspaceId: req.ctx!.workspaceId,
  });

  const notFound = (res: Parameters<typeof sendError>[0]) =>
    sendError(res, 'not_found', 'Not found');

  const clients = deps.paymentClients ?? defaultPaymentClients();

  router.post(
    '/invoices/:id/payment-links',
    requireScopes('payments:write', 'invoices:read'),
    requireIdempotencyKey(),
    async (req, res) => {
      const parsed = idParamSchema.safeParse(req.params);
      const input = createPaymentLinkSchema.parse(req.body);
      if (!parsed.success) return notFound(res);

      const { workspaceId } = ctxOf(req);

      const invoice = await db.invoice.findFirst({
        where: { id: parsed.data.id, workspaceId },
        include: { client: { select: { name: true, email: true, phone: true } } },
      });
      if (!invoice) return notFound(res);

      try {
        // The idempotency middleware stops a retried request from opening a
        // second link and payment row.
        const link = await startInvoicePayment(db, clients, invoice, {
          provider: input.provider,
          appUrl: deps.appUrl ?? process.env.APP_URL ?? 'http://localhost:3000',
        });
        sendData(res, paymentLinkResponseSchema.parse(link));
      } catch (error) {
        if (error instanceof CoreError) {
          return sendError(res, error.code, error.message);
        }
        throw error;
      }
    }
  );

  return router;
}
