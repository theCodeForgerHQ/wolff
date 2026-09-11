import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { incrementNumberSequence, type Prisma } from '@wolff/database';
import type { Db } from '@wolff/core/context';
import { renderQuoteSent, senderName } from '@wolff/core/email';
import { requestAiIndexing, requestPdfRender } from '@wolff/core/outbox';
import { applyDiscount } from '@wolff/core/pricing';
import '../../../context';
import { requireScopes } from '../../../middleware/auth';
import type { LegacyRouteContext } from '.';
import { EMAIL_LIMIT_MESSAGE } from './email';
import { DOCUMENT_INCLUDE, formatLineItem, formatQuote, formatShortLineItem } from './format';
import {
  EMAIL_PATTERN,
  INVALID_JSON,
  legacyError,
  legacyJson,
  pageParams,
  queryParam,
  readJsonBody,
  readOptionalJsonBody,
  stripProtectedFields,
  toNumber,
  param,
  BAD_RECIPIENTS,
  badRecipients,
  fieldTypeProblem,
} from './http';
import {
  MAX_LINE_ITEMS,
  lineItemProblem,
  priceLines,
  type LineItemInput,
  LINE_ITEMS_NOT_A_LIST,
} from './line-items';

const QUOTE_STATUSES = ['draft', 'sent', 'viewed', 'accepted', 'declined', 'expired', 'converted'];
const SENDABLE = ['draft', 'sent', 'viewed'];
const TRANSITIONS: Record<string, string[]> = {
  draft: ['sent'],
  sent: ['viewed', 'accepted', 'declined', 'expired'],
  viewed: ['accepted', 'declined', 'expired'],
  accepted: [],
  declined: ['draft'],
  expired: ['draft'],
};
/** Statuses after which a quote's content is the signed contract. */
const SIGNED_STATUSES = ['accepted', 'converted'] as const;
const CURRENCY = /^[A-Z]{3}$/;

/** The next quote number ("Q-0001"), from the workspace's sequence. */
async function nextQuoteNumber(db: Db, workspaceId: string): Promise<string> {
  const seq = await db.$transaction((tx) =>
    incrementNumberSequence(tx as unknown as Prisma.TransactionClient, workspaceId, 'quote', null, {
      prefix: 'Q-',
      currentValue: 1,
      padding: 4,
    })
  );
  return `${seq.prefix || 'Q-'}${String(seq.currentValue).padStart(seq.padding, '0')}`;
}

/**
 * `/v1/quotes`, `/v1/quotes/:id`, `/v1/quotes/:id/send` and
 * `/v1/quotes/:id/duplicate`, ported from apps/web/app/api/v1/quotes/**. The
 * workspace is always the API key's (`req.ctx.workspaceId`).
 */
export function quoteRoutes(db: Db, deps: LegacyRouteContext): Router {
  const router = Router();
  const { sendEmail } = deps;

  router.get('/quotes', requireScopes('quotes:read'), async (req, res) => {
    const workspaceId = req.ctx!.workspaceId;
    const { page, limit } = pageParams(req);
    const status = queryParam(req, 'status');
    const search = queryParam(req, 'search');

    const where: Prisma.QuoteWhereInput = { workspaceId, deletedAt: null };
    if (status) {
      if (!QUOTE_STATUSES.includes(status)) {
        return legacyError(res, `Invalid status: ${status}`, 400);
      }
      where.status = status;
    }
    if (search) where.title = { contains: search, mode: 'insensitive' };

    const [quotes, total] = await Promise.all([
      db.quote.findMany({
        where,
        include: DOCUMENT_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      db.quote.count({ where }),
    ]);

    legacyJson(res, {
      data: quotes.map(formatQuote),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  });

  router.post('/quotes', requireScopes('quotes:write'), async (req, res) => {
    const workspaceId = req.ctx!.workspaceId;
    const parsed = readJsonBody(req);
    if (parsed === INVALID_JSON) return legacyError(res, 'Invalid JSON body', 400);
    const fields = stripProtectedFields(parsed);
    const { title, clientId, projectId, currency, lineItems } = fields as {
      title?: string;
      clientId?: string;
      projectId?: string;
      currency?: string;
      lineItems?: LineItemInput[];
    };
    if (lineItems && !Array.isArray(lineItems)) return legacyError(res, LINE_ITEMS_NOT_A_LIST, 400);

    if (!clientId) return legacyError(res, 'clientId is required', 400);
    if (!title) return legacyError(res, 'title is required', 400);
    const wrongType = fieldTypeProblem(fields, {
      clientId: 'string',
      title: 'string',
      projectId: 'string-or-null',
      currency: 'string-or-null',
    });
    if (wrongType) return legacyError(res, wrongType, 400);
    if (currency && (currency.length !== 3 || !CURRENCY.test(currency.toUpperCase()))) {
      return legacyError(res, 'Currency must be a valid 3-letter ISO code (e.g., USD, EUR)', 400);
    }

    const client = await db.client.findFirst({
      where: { id: clientId, workspaceId, deletedAt: null },
    });
    if (!client) return legacyError(res, 'Client not found', 404);
    if (projectId) {
      const project = await db.project.findFirst({
        where: { id: projectId, workspaceId, deletedAt: null },
      });
      if (!project) return legacyError(res, 'Project not found', 404);
    }

    // Numbered before the lines are checked, as before: a refused quote
    // still uses a number.
    const quoteNumber = await nextQuoteNumber(db, workspaceId);

    const items = lineItems || [];
    if (items.length > MAX_LINE_ITEMS)
      return legacyError(res, 'Maximum 100 line items allowed', 400);
    const invalid = lineItemProblem(items, 'quote-create');
    if (invalid) return legacyError(res, invalid, 400);

    const { lines, subtotal, taxTotal } = priceLines(items);
    const profile = currency
      ? null
      : await db.businessProfile.findUnique({
          where: { workspaceId },
          select: { currency: true },
        });

    const quote = await db.quote.create({
      data: {
        workspaceId,
        clientId,
        projectId: projectId || null,
        quoteNumber,
        title,
        currency: currency || profile?.currency || 'USD',
        subtotal,
        taxTotal,
        total: subtotal + taxTotal,
        settings: {},
        lineItems: {
          create: lines.map((line) => ({ ...line, taxRate: line.taxRate || null })),
        },
      },
      include: DOCUMENT_INCLUDE,
    });

    legacyJson(
      res,
      {
        id: quote.id,
        quoteNumber: quote.quoteNumber,
        title: quote.title,
        status: quote.status,
        client: quote.client,
        currency: quote.currency,
        subtotal: toNumber(quote.subtotal),
        taxTotal: toNumber(quote.taxTotal),
        total: toNumber(quote.total),
        lineItems: quote.lineItems.map(formatShortLineItem),
        createdAt: quote.createdAt,
      },
      201
    );
  });

  router.get('/quotes/:id', requireScopes('quotes:read'), async (req, res) => {
    const workspaceId = req.ctx!.workspaceId;
    const quote = await db.quote.findFirst({
      where: { id: param(req, 'id'), workspaceId, deletedAt: null },
      include: DOCUMENT_INCLUDE,
    });
    if (!quote) return legacyError(res, 'Quote not found', 404);
    legacyJson(res, formatQuote(quote));
  });

  router.patch('/quotes/:id', requireScopes('quotes:write'), async (req, res) => {
    const workspaceId = req.ctx!.workspaceId;
    const id = param(req, 'id');
    const parsed = readJsonBody(req);
    if (parsed === INVALID_JSON) return legacyError(res, 'Invalid JSON body', 400);
    const fields = stripProtectedFields(parsed);
    const { title, notes, terms, status, lineItems } = fields as {
      title?: string;
      notes?: string;
      terms?: string;
      status?: string;
      lineItems?: LineItemInput[];
    };
    if (lineItems && !Array.isArray(lineItems)) return legacyError(res, LINE_ITEMS_NOT_A_LIST, 400);
    const wrongType = fieldTypeProblem(fields, {
      title: 'string-or-null',
      notes: 'string-or-null',
      terms: 'string-or-null',
    });
    if (wrongType) return legacyError(res, wrongType, 400);

    if (lineItems) {
      const invalid = lineItemProblem(lineItems, 'quote-update');
      if (invalid) return legacyError(res, invalid, 400);
    }

    // Status check and update in one transaction (no TOCTOU between them).
    const result = await db.$transaction(async (tx) => {
      // A content edit first claims the row on the "not yet signed" condition:
      // the row lock makes a concurrent accept/sign wait, and a quote that is
      // already accepted, converted or signed matches nothing.
      const editsContent =
        title !== undefined || notes !== undefined || terms !== undefined || !!lineItems;
      if (editsContent) {
        const claimed = await tx.quote.updateMany({
          where: {
            id,
            workspaceId,
            deletedAt: null,
            status: { notIn: [...SIGNED_STATUSES] },
            signedAt: null,
          },
          data: { updatedAt: new Date() },
        });
        if (claimed.count === 0) {
          const locked = await tx.quote.findFirst({
            where: { id, workspaceId, deletedAt: null },
            select: { status: true },
          });
          if (!locked) return { error: 'Quote not found', status: 404 } as const;
          // Same words as the Next route for the accepted case (parity).
          const what = locked.status === 'accepted' ? 'an accepted' : 'a signed';
          return {
            error: lineItems
              ? `Cannot modify line items on ${what} quote`
              : 'Cannot modify a quote that has been accepted or signed',
            status: 400,
          } as const;
        }
      }

      const quote = await tx.quote.findFirst({ where: { id, workspaceId, deletedAt: null } });
      if (!quote) return { error: 'Quote not found', status: 404 } as const;

      const data: Prisma.QuoteUpdateInput = {};
      if (title !== undefined) data.title = title;
      if (notes !== undefined) data.notes = notes;
      if (terms !== undefined) data.terms = terms;
      if (status !== undefined) {
        const allowed = TRANSITIONS[quote.status];
        if (!allowed || !allowed.includes(status)) {
          return {
            error: `Cannot transition from '${quote.status}' to '${status}'`,
            status: 400,
          } as const;
        }
        data.status = status;
        if (status === 'accepted') data.acceptedAt = new Date();
        if (status === 'declined') data.declinedAt = new Date();
        if (status === 'sent') data.sentAt = new Date();
      }

      if (lineItems) {
        const { lines, subtotal, taxTotal } = priceLines(lineItems);
        // The discount comes off before tax (shared with the dashboard).
        const priced = applyDiscount(
          { subtotal, taxTotal },
          quote.discountType,
          quote.discountValue ? toNumber(quote.discountValue) : 0
        );
        data.subtotal = subtotal;
        data.taxTotal = priced.taxTotal;
        data.discountAmount = priced.discountAmount;
        data.total = priced.total;

        await tx.quoteLineItem.deleteMany({ where: { quoteId: id, quote: { workspaceId } } });
        await tx.quoteLineItem.createMany({
          data: lines.map((line) => ({
            ...line,
            quoteId: id,
            taxRate: line.taxRate != null ? line.taxRate : null,
          })),
        });
      }

      const updated = await tx.quote.update({
        where: { id, workspaceId },
        data,
        include: DOCUMENT_INCLUDE,
      });
      return { data: updated } as const;
    });

    if (!('data' in result) || !result.data) {
      return legacyError(res, result.error ?? 'Unexpected error', result.status ?? 500);
    }

    await db.quoteEvent
      .create({
        data: { quoteId: id, eventType: 'updated', actorType: 'system', metadata: { via: 'api' } },
      })
      .catch(() => {});

    legacyJson(res, formatQuote(result.data));
  });

  router.delete('/quotes/:id', requireScopes('quotes:write'), async (req, res) => {
    const workspaceId = req.ctx!.workspaceId;
    const id = param(req, 'id');
    const quote = await db.quote.findFirst({ where: { id, workspaceId, deletedAt: null } });
    if (!quote) return legacyError(res, 'Quote not found', 404);

    const outbox = await db.$transaction(async (tx) => {
      await tx.quote.update({ where: { id, workspaceId }, data: { deletedAt: new Date() } });
      // The AI service drops the soft-deleted document from its index.
      return requestAiIndexing(tx, { workspaceId, sourceType: 'quote', sourceId: id });
    });
    await deps.onOutboxEvents?.([outbox.id]);

    legacyJson(res, { message: 'Quote deleted' });
  });

  router.post('/quotes/:id/duplicate', requireScopes('quotes:write'), async (req, res) => {
    const workspaceId = req.ctx!.workspaceId;
    const original = await db.quote.findFirst({
      where: { id: param(req, 'id'), workspaceId, deletedAt: null },
      include: DOCUMENT_INCLUDE,
    });
    if (!original) return legacyError(res, 'Quote not found', 404);

    const quoteNumber = await nextQuoteNumber(db, workspaceId);
    const copy = await db.quote.create({
      data: {
        workspaceId,
        clientId: original.clientId,
        projectId: original.projectId,
        quoteNumber,
        title: `${original.title || 'Untitled'} (Copy)`,
        status: 'draft',
        currency: original.currency,
        accessToken: randomBytes(32).toString('hex'),
        subtotal: original.subtotal,
        discountType: original.discountType,
        discountValue: original.discountValue,
        discountAmount: original.discountAmount,
        taxTotal: original.taxTotal,
        total: original.total,
        notes: original.notes,
        terms: original.terms,
        settings: original.settings as Prisma.InputJsonValue,
        lineItems: {
          create: original.lineItems.map((item) => ({
            name: item.name,
            description: item.description,
            quantity: item.quantity,
            rate: item.rate,
            amount: item.amount,
            taxRate: item.taxRate,
            taxAmount: item.taxAmount,
            sortOrder: item.sortOrder,
          })),
        },
      },
      include: DOCUMENT_INCLUDE,
    });

    legacyJson(
      res,
      {
        id: copy.id,
        quoteNumber: copy.quoteNumber,
        title: copy.title,
        status: copy.status,
        client: copy.client,
        currency: copy.currency,
        subtotal: toNumber(copy.subtotal),
        discountType: copy.discountType,
        discountValue: copy.discountValue ? toNumber(copy.discountValue) : null,
        discountAmount: toNumber(copy.discountAmount),
        taxTotal: toNumber(copy.taxTotal),
        total: toNumber(copy.total),
        lineItems: copy.lineItems.map(formatLineItem),
        createdAt: copy.createdAt,
      },
      201
    );
  });

  router.post('/quotes/:id/send', requireScopes('quotes:write'), async (req, res) => {
    const workspaceId = req.ctx!.workspaceId;
    const id = param(req, 'id');
    const body = readOptionalJsonBody(req);
    const { message, recipients } = body as { message?: string; recipients?: string[] };

    if (badRecipients(recipients)) return legacyError(res, BAD_RECIPIENTS, 400);
    const wrongType = fieldTypeProblem(body, { message: 'string-or-null' });
    if (wrongType) return legacyError(res, wrongType, 400);
    if (recipients) {
      if (recipients.length > 10) return legacyError(res, 'Maximum 10 recipients allowed', 400);
      const invalid = recipients.filter((e) => !EMAIL_PATTERN.test(e));
      if (invalid.length > 0) {
        return legacyError(res, `Invalid email addresses: ${invalid.join(', ')}`, 400);
      }
    }

    const quote = await db.quote.findFirst({
      where: { id, workspaceId, deletedAt: null },
      include: DOCUMENT_INCLUDE,
    });
    if (!quote) return legacyError(res, 'Quote not found', 404);
    if (!SENDABLE.includes(quote.status)) {
      return legacyError(res, `Cannot send a quote with status: ${quote.status}`, 400);
    }
    if (!quote.client?.email && (!recipients || recipients.length === 0)) {
      return legacyError(res, 'Client email is required to send quote', 400);
    }
    if (Math.abs(toNumber(quote.total)) < 0.01) {
      return legacyError(res, 'Cannot send a quote with zero total. Add line items first.', 400);
    }

    const workspace = await db.workspace.findUnique({
      where: { id: workspaceId },
      select: { name: true, businessProfile: { select: { businessName: true } } },
    });
    const quoteUrl = `${deps.appUrl}/q/${quote.accessToken}`;
    const result = await sendEmail({
      workspaceId,
      recipients: recipients?.length ? recipients : [quote.client!.email],
      email: renderQuoteSent({
        clientName: quote.client!.name,
        quoteName: quote.title || quote.quoteNumber,
        quoteUrl,
        businessName: workspace ? senderName(workspace) : 'Wolff',
        validUntil: quote.expirationDate,
        message: message || undefined,
      }),
      reference: `quote:${id}`,
      version: quote.updatedAt.toISOString(),
    });
    const emailSent = result.outcome === 'sent';

    // The status changes only when the email went out, and only from the
    // status read above: of two sends of one draft, one issues the quote
    // (PDF render, `sent` event); the other finds it already sent and
    // records nothing. The email itself is deduplicated by the provider.
    let won = false;
    if (emailSent) {
      const outbox = await db.$transaction(async (tx) => {
        const { count } = await tx.quote.updateMany({
          where: { id, workspaceId, status: quote.status },
          data: { status: 'sent', sentAt: new Date() },
        });
        won = count === 1;
        // Issued now: render its PDF (a resend changes nothing the client sees).
        return won && quote.status === 'draft'
          ? requestPdfRender(tx, { workspaceId, documentType: 'quote', documentId: id })
          : null;
      });
      if (outbox) await deps.onOutboxEvents?.([outbox.id]);
    }

    if (won || !emailSent) {
      await db.quoteEvent
        .create({
          data: {
            quoteId: id,
            eventType: emailSent ? 'sent' : 'send_failed',
            actorType: 'system',
            metadata: { via: 'api', emailSent },
          },
        })
        .catch(() => {});
    }

    if (result.outcome === 'limited') {
      res.set('Retry-After', String(result.retryAfterS));
      return legacyError(res, EMAIL_LIMIT_MESSAGE, 429);
    }
    if (!emailSent) {
      return legacyError(res, 'Quote email could not be sent. Status unchanged.', 502);
    }
    legacyJson(res, { message: 'Quote sent successfully', emailSent, quoteUrl });
  });

  return router;
}
