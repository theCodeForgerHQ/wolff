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
import {
  createPaymentLink,
  type PaymentProviderClients,
  type PaymentProvider,
} from '../../payments/provider';
import Stripe from 'stripe';
import Razorpay from 'razorpay';

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

  const clients = deps.paymentClients ?? {
    stripe: new Stripe(process.env.STRIPE_SECRET_KEY ?? 'sk_test_placeholder', {
      apiVersion: '2026-08-26.dahlia',
      typescript: true,
    }),
    razorpay: new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID ?? 'rzp_test_placeholder',
      key_secret: process.env.RAZORPAY_KEY_SECRET ?? 'secret_placeholder',
    }),
  };

  router.post(
    '/invoices/:id/payment-links',
    requireScopes('payments:write', 'invoices:read'),
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

      const settings = await db.paymentSettings.findUnique({
        where: { workspaceId },
      });
      if (!settings) {
        return sendError(res, 'not_configured', 'Payment settings not found');
      }

      try {
        const link = await createPaymentLink(
          clients,
          {
            id: invoice.id,
            workspaceId: invoice.workspaceId,
            clientId: invoice.clientId,
            total: Number(invoice.total),
            currency: invoice.currency,
            status: invoice.status,
            invoiceNumber: invoice.invoiceNumber,
            client: invoice.client,
          },
          {
            stripeAccountId: settings.stripeAccountId,
            chargesEnabled: settings.chargesEnabled,
            razorpayKeyId: settings.razorpayKeyId,
            razorpayKeySecretEnc: settings.razorpayKeySecretEnc,
            defaultProviderByCurrency: (settings.defaultProviderByCurrency as Record<
              string,
              PaymentProvider
            >) ?? { '*': 'stripe' },
          },
          {
            provider: input.provider,
            appUrl: deps.appUrl ?? process.env.APP_URL ?? 'http://localhost:3000',
          }
        );

        await db.payment.create({
          data: {
            workspaceId,
            invoiceId: invoice.id,
            amount: invoice.total,
            currency: invoice.currency,
            status: 'pending',
            provider: link.provider,
            providerOrderId: link.provider === 'stripe' ? link.sessionId : link.orderId,
            paymentMethod: 'online',
            processedAt: new Date(),
          },
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
