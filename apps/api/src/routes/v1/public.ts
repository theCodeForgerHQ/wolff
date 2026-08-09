import { Router } from 'express';
import type { Db } from '@wolff/core/context';
import { createLead } from '@wolff/core/crm';
import { createLeadSchema } from '@wolff/contracts';
import '../../context';
import { sendData, sendError } from '../../http';
import { apiKeyRateLimit, requirePublishableKey, requireScopes } from '../../middleware/auth';
import type { Store } from 'express-rate-limit';
import type { PaymentProviderClients } from '../../payments/provider';

export interface PublicRoutesDeps {
  db: Db;
  rateLimitStore?: Store;
  paymentClients?: PaymentProviderClients;
  appUrl?: string;
}

function toNumber(value: unknown): number {
  const n = typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function publicRoutes(deps: PublicRoutesDeps): Router {
  const { db } = deps;
  const router = Router();

  const ctxOf = (req: Express.Request) => ({
    db,
    workspaceId: req.ctx!.workspaceId,
  });

  router.use(requirePublishableKey(db), apiKeyRateLimit(deps.rateLimitStore));

  router.post('/leads', requireScopes('lead:create'), async (req, res) => {
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
    sendData(res, { id: lead.id, message: 'Lead submitted.' }, 201);
  });

  router.post('/invoices/:token/pay', requireScopes('invoice:pay'), async (req, res) => {
    const token = req.params.token as string;
    if (!token) {
      sendError(res, 'validation_error', 'Invoice token is required');
      return;
    }

    // Resolve the invoice by its public payment token.
    const payment = await db.payment.findFirst({
      where: {
        workspaceId: req.ctx!.workspaceId,
        providerOrderId: token,
        status: 'pending',
      },
      include: { invoice: true },
    });

    if (!payment || !payment.invoice) {
      sendError(res, 'not_found', 'Invoice not found or already paid');
      return;
    }

    const invoice = payment.invoice;
    const providers = deps.paymentClients;
    const baseUrl = deps.appUrl ?? 'http://localhost:3000';
    const successUrl = `${baseUrl}/invoices/${invoice.id}/paid?token=${token}`;
    const cancelUrl = `${baseUrl}/invoices/${invoice.id}?token=${token}`;

    if (invoice.currency === 'INR') {
      const razorpay = providers?.razorpay;
      if (!razorpay) {
        sendError(res, 'internal_error', 'Razorpay is not configured');
        return;
      }
      const amount = toNumber(invoice.total);
      const order = await razorpay.orders.create({
        amount: Math.round(amount * 100),
        currency: invoice.currency,
        receipt: payment.id,
        notes: { invoiceId: invoice.id, workspaceId: invoice.workspaceId },
      });
      await db.payment.update({
        where: { id: payment.id, workspaceId: invoice.workspaceId },
        data: { providerOrderId: order.id },
      });
      sendData(res, {
        checkoutUrl: '',
        provider: 'razorpay',
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
      });
      return;
    }

    const stripe = providers?.stripe;
    if (!stripe) {
      sendError(res, 'internal_error', 'Stripe is not configured');
      return;
    }
    const amount = toNumber(invoice.total);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: invoice.currency.toLowerCase(),
            product_data: { name: `Invoice ${invoice.invoiceNumber}` },
            unit_amount: Math.round(amount * 100),
          },
          quantity: 1,
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { invoiceId: invoice.id, paymentId: payment.id, workspaceId: invoice.workspaceId },
    });
    sendData(res, { checkoutUrl: session.url ?? '', provider: 'stripe' });
  });

  router.get('/quotes/:token', async (req, res) => {
    const token = req.params.token as string;
    if (!token) {
      sendError(res, 'validation_error', 'Quote token is required');
      return;
    }

    const quote = await db.quote.findFirst({
      where: {
        workspaceId: req.ctx!.workspaceId,
        OR: [{ id: token }, { accessToken: token }],
      },
      select: { id: true, title: true, status: true },
    });

    if (!quote) {
      sendError(res, 'not_found', 'Quote not found');
      return;
    }

    sendData(res, quote);
  });

  return router;
}
