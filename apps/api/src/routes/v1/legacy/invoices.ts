import { Router, type Response } from 'express';
import type { Prisma } from '@wolff/database';
import type { Db } from '@wolff/core/context';
import { formatMoney, renderInvoiceSent, senderName } from '@wolff/core/email';
import { CoreError } from '@wolff/core/errors';
import {
  assertReadyToIssue,
  createInvoiceFromQuote,
  describeCoreError,
  gstInvoiceColumns,
  allocateInvoiceNumber,
  priceForWorkspace,
  type PricedGstInvoice,
} from '@wolff/core/invoices';
import { requestAiIndexing, requestPdfRender } from '@wolff/core/outbox';
import { applyDiscount } from '@wolff/core/pricing';
import '../../../context';
import { requireScopes } from '../../../middleware/auth';
import type { LegacyRouteContext } from '.';
import { EMAIL_LIMIT_MESSAGE } from './email';
import { DOCUMENT_INCLUDE, formatInvoice, formatShortLineItem } from './format';
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

const INVOICE_STATUSES = ['draft', 'sent', 'viewed', 'partial', 'paid', 'overdue', 'voided'];
const SENDABLE = ['draft', 'sent', 'viewed'];
const LOCKED = ['paid', 'voided'];
const TRANSITIONS: Record<string, string[]> = {
  draft: ['sent'],
  sent: ['viewed', 'partial', 'paid', 'overdue', 'voided'],
  viewed: ['partial', 'paid', 'overdue', 'voided'],
  partial: ['paid', 'voided'],
  paid: ['voided'],
  overdue: ['paid', 'partial', 'voided'],
  voided: [],
};
const CURRENCY = /^[A-Z]{3}$/;

/** The engine's view of the lines (GST workspaces). */
const gstLines = (items: LineItemInput[]) =>
  items.map((item) => ({
    name: item.name,
    description: item.description || null,
    quantity: item.quantity,
    rate: item.rate,
    gstRate: item.taxRate ?? 0,
    hsnSac: item.hsnSac?.trim() || null,
    itemType: item.itemType,
  }));

/** Why a draft may not be issued (Rule 46), or null. */
async function issueBlocker(db: Db, workspaceId: string, id: string): Promise<string | null> {
  try {
    await assertReadyToIssue(db, workspaceId, id);
    return null;
  } catch (error) {
    if (error instanceof CoreError) return describeCoreError(error);
    throw error;
  }
}

/** The audit event the Next routes wrote after an API update; never fails the request. */
const recordUpdate = (db: Db, invoiceId: string) =>
  db.invoiceEvent
    .create({
      data: { invoiceId, eventType: 'updated', actorType: 'system', metadata: { via: 'api' } },
    })
    .catch(() => {});

/**
 * `/v1/invoices`, `/v1/invoices/:id`, `/v1/invoices/:id/send` and
 * `/v1/invoices/from-quote/:quoteId`, ported from
 * apps/web/app/api/v1/invoices/**. The workspace is always the API key's
 * (`req.ctx.workspaceId`).
 */
export function legacyInvoiceRoutes(db: Db, deps: LegacyRouteContext): Router {
  const router = Router();
  const { sendEmail } = deps;

  router.get('/invoices', requireScopes('invoices:read'), async (req, res) => {
    const workspaceId = req.ctx!.workspaceId;
    const { page, limit } = pageParams(req);
    const status = queryParam(req, 'status');
    const clientId = queryParam(req, 'clientId');
    const search = queryParam(req, 'search');

    const where: Prisma.InvoiceWhereInput = { workspaceId, deletedAt: null };
    if (status) {
      if (!INVOICE_STATUSES.includes(status)) return legacyError(res, 'Invalid status value', 400);
      where.status = status;
    }
    if (clientId) where.clientId = clientId;
    if (search) where.title = { contains: search, mode: 'insensitive' };

    const [invoices, total] = await Promise.all([
      db.invoice.findMany({
        where,
        include: DOCUMENT_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      db.invoice.count({ where }),
    ]);

    legacyJson(res, {
      data: invoices.map((inv) => formatInvoice(inv)),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  });

  router.post('/invoices', requireScopes('invoices:write'), async (req, res) => {
    const workspaceId = req.ctx!.workspaceId;
    const parsed = readJsonBody(req);
    if (parsed === INVALID_JSON) return legacyError(res, 'Invalid JSON body', 400);
    const fields = stripProtectedFields(parsed);
    const { title, clientId, projectId, currency, dueDate, lineItems, notes, terms } = fields as {
      title?: string;
      clientId?: string;
      projectId?: string;
      currency?: string;
      dueDate?: string;
      lineItems?: LineItemInput[];
      notes?: string;
      terms?: string;
    };

    if (lineItems && !Array.isArray(lineItems)) return legacyError(res, LINE_ITEMS_NOT_A_LIST, 400);
    if (!clientId) return legacyError(res, 'clientId is required', 400);
    if (!title) return legacyError(res, 'title is required', 400);
    if (!dueDate) return legacyError(res, 'dueDate is required', 400);
    const wrongType = fieldTypeProblem(fields, {
      clientId: 'string',
      title: 'string',
      projectId: 'string-or-null',
      currency: 'string-or-null',
      notes: 'string-or-null',
      terms: 'string-or-null',
    });
    if (wrongType) return legacyError(res, wrongType, 400);
    if (currency && (currency.length !== 3 || !CURRENCY.test(currency.toUpperCase()))) {
      return legacyError(res, 'Currency must be a valid 3-letter ISO code (e.g., USD, EUR)', 400);
    }
    const parsedDueDate = new Date(dueDate);
    if (isNaN(parsedDueDate.getTime()))
      return legacyError(res, 'dueDate must be a valid date', 400);

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

    const items = lineItems || [];
    if (items.length > MAX_LINE_ITEMS)
      return legacyError(res, 'Maximum 100 line items allowed', 400);
    const invalid = lineItemProblem(items, 'invoice');
    if (invalid) return legacyError(res, invalid, 400);

    // A GST workspace prices with the engine; the invoice is a
    // draft and leaves draft only through the Rule 46 check.
    let gst: PricedGstInvoice | null;
    try {
      gst = await priceForWorkspace(db, workspaceId, { client, lines: gstLines(items) });
    } catch (error) {
      if (error instanceof CoreError) return legacyError(res, error.message, 422);
      throw error;
    }

    const { lines, subtotal, taxTotal } = priceLines(items);
    const total = subtotal + taxTotal;
    const amounts = gst
      ? { ...gstInvoiceColumns(gst), amountDue: gst.invoice.total }
      : { subtotal, taxTotal, total, amountDue: total };
    const created: Prisma.InvoiceLineItemCreateWithoutInvoiceInput[] = gst
      ? gst.lines
      : lines.map((line) => ({ ...line, taxRate: line.taxRate != null ? line.taxRate : null }));
    const profile = currency
      ? null
      : await db.businessProfile.findUnique({
          where: { workspaceId },
          select: { currency: true },
        });

    // Numbered in the transaction that inserts it: a failed insert takes
    // the number back (GST Rule 46 wants a consecutive series).
    const invoice = await db.$transaction(async (tx) =>
      tx.invoice.create({
        data: {
          workspaceId,
          clientId,
          projectId: projectId || null,
          invoiceNumber: await allocateInvoiceNumber(tx, workspaceId),
          title,
          currency: currency || profile?.currency || 'USD',
          dueDate: parsedDueDate,
          ...amounts,
          notes: notes || null,
          terms: terms || null,
          settings: {},
          lineItems: { create: created },
        },
        include: DOCUMENT_INCLUDE,
      })
    );

    legacyJson(
      res,
      {
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        title: invoice.title,
        status: invoice.status,
        client: invoice.client,
        currency: invoice.currency,
        dueDate: invoice.dueDate,
        subtotal: toNumber(invoice.subtotal),
        taxTotal: toNumber(invoice.taxTotal),
        total: toNumber(invoice.total),
        amountPaid: 0,
        amountDue: toNumber(invoice.amountDue),
        lineItems: invoice.lineItems.map(formatShortLineItem),
        createdAt: invoice.createdAt,
      },
      201
    );
  });

  // Converting changes the quote too (status 'converted').
  router.post(
    '/invoices/from-quote/:quoteId',
    requireScopes('invoices:write', 'quotes:write'),
    async (req, res) => {
      const workspaceId = req.ctx!.workspaceId;
      const { dueDays } = readOptionalJsonBody(req) as { dueDays?: number };
      if (dueDays !== undefined) {
        if (!Number.isFinite(dueDays) || dueDays < 0 || dueDays > 365) {
          return legacyError(res, 'dueDays must be a number between 0 and 365', 400);
        }
      }

      const result = await createInvoiceFromQuote(db, workspaceId, param(req, 'quoteId'), {
        dueDays: dueDays ?? 30,
      });
      if (!result.success) {
        const status = result.error === 'Quote not found' ? 404 : 400;
        return legacyError(res, result.error || 'Failed to create invoice from quote', status);
      }

      const invoice = await db.invoice.findFirst({
        where: { id: result.invoice!.id, workspaceId },
        include: DOCUMENT_INCLUDE,
      });
      if (!invoice) return legacyError(res, 'Invoice created but not found', 500);
      legacyJson(res, formatInvoice(invoice), 201);
    }
  );

  router.get('/invoices/:id', requireScopes('invoices:read'), async (req, res) => {
    const workspaceId = req.ctx!.workspaceId;
    const invoice = await db.invoice.findFirst({
      where: { id: param(req, 'id'), workspaceId, deletedAt: null },
      include: DOCUMENT_INCLUDE,
    });
    if (!invoice) return legacyError(res, 'Invoice not found', 404);
    legacyJson(res, formatInvoice(invoice, { voidedAt: true }));
  });

  router.patch('/invoices/:id', requireScopes('invoices:write'), async (req, res) => {
    await updateInvoice(db, req.ctx!.workspaceId, param(req, 'id'), readJsonBody(req), res);
  });

  router.delete('/invoices/:id', requireScopes('invoices:write'), async (req, res) => {
    const workspaceId = req.ctx!.workspaceId;
    const id = param(req, 'id');
    const invoice = await db.invoice.findFirst({ where: { id, workspaceId, deletedAt: null } });
    if (!invoice) return legacyError(res, 'Invoice not found', 404);
    if (['paid', 'partial'].includes(invoice.status)) {
      return legacyError(res, `Cannot delete a ${invoice.status} invoice. Void it instead.`, 400);
    }

    const outbox = await db.$transaction(async (tx) => {
      await tx.invoice.update({ where: { id, workspaceId }, data: { deletedAt: new Date() } });
      // The AI service drops the soft-deleted document from its index.
      return requestAiIndexing(tx, { workspaceId, sourceType: 'invoice', sourceId: id });
    });
    await deps.onOutboxEvents?.([outbox.id]);
    legacyJson(res, { message: 'Invoice deleted' });
  });

  router.post('/invoices/:id/send', requireScopes('invoices:write'), async (req, res) => {
    const workspaceId = req.ctx!.workspaceId;
    const id = param(req, 'id');
    const body = readOptionalJsonBody(req);
    const { message, recipients } = body as { message?: string; recipients?: string[] };

    if (badRecipients(recipients)) return legacyError(res, BAD_RECIPIENTS, 400);
    const wrongType = fieldTypeProblem(body, { message: 'string-or-null' });
    if (wrongType) return legacyError(res, wrongType, 400);
    if (recipients) {
      if (recipients.length > 10) return legacyError(res, 'Maximum 10 recipients allowed', 400);
      if (recipients.some((e) => !EMAIL_PATTERN.test(e))) {
        return legacyError(res, 'One or more email addresses are invalid', 400);
      }
    }

    const invoice = await db.invoice.findFirst({
      where: { id, workspaceId, deletedAt: null },
      include: { client: DOCUMENT_INCLUDE.client },
    });
    if (!invoice) return legacyError(res, 'Invoice not found', 404);
    if (!SENDABLE.includes(invoice.status)) {
      return legacyError(res, `Cannot send an invoice with status: ${invoice.status}`, 400);
    }
    if (!invoice.client?.email && (!recipients || recipients.length === 0)) {
      return legacyError(res, 'Client email is required to send invoice', 400);
    }
    if (Math.abs(toNumber(invoice.total)) < 0.01) {
      return legacyError(res, 'Cannot send an invoice with zero total. Add line items first.', 400);
    }
    // Leaving draft issues the invoice: a GST invoice must carry Rule 46's
    // details first, checked before the email so the client never receives
    // an invoice that stays a draft.
    if (invoice.status === 'draft') {
      const blocker = await issueBlocker(db, workspaceId, id);
      if (blocker) return legacyError(res, blocker, 422);
    }

    const workspace = await db.workspace.findUnique({
      where: { id: workspaceId },
      select: { name: true, businessProfile: { select: { businessName: true } } },
    });
    const invoiceUrl = `${deps.appUrl}/i/${invoice.accessToken}`;
    const result = await sendEmail({
      workspaceId,
      recipients: recipients?.length ? recipients : [invoice.client!.email],
      email: renderInvoiceSent({
        clientName: invoice.client!.name,
        invoiceNumber: invoice.invoiceNumber,
        invoiceUrl,
        businessName: workspace ? senderName(workspace) : 'Wolff',
        amount: formatMoney(toNumber(invoice.total), invoice.currency),
        dueDate: invoice.dueDate,
        message: message || undefined,
      }),
      reference: `invoice:${id}`,
      version: invoice.updatedAt.toISOString(),
    });
    const emailSent = result.outcome === 'sent';

    // The status changes only when the email went out, and only from the
    // status read above: of two sends of one draft, one issues the invoice
    // (PDF render, `sent` event); the other finds it already sent and
    // records nothing. The email itself is deduplicated by the provider.
    let won = false;
    if (emailSent) {
      const outbox = await db.$transaction(async (tx) => {
        const { count } = await tx.invoice.updateMany({
          where: { id, workspaceId, status: invoice.status },
          data: { status: 'sent', sentAt: new Date() },
        });
        won = count === 1;
        // Issued now: render its PDF (a resend changes nothing the client sees).
        return won && invoice.status === 'draft'
          ? requestPdfRender(tx, { workspaceId, documentType: 'invoice', documentId: id })
          : null;
      });
      if (outbox) await deps.onOutboxEvents?.([outbox.id]);
    }

    if (won || !emailSent) {
      await db.invoiceEvent
        .create({
          data: {
            invoiceId: id,
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
      return legacyError(res, 'Invoice email could not be sent. Status unchanged.', 502);
    }
    legacyJson(res, { message: 'Invoice sent successfully', emailSent, invoiceUrl });
  });

  return router;
}

/** PATCH /v1/invoices/:id, in the order the Next route checked things. */
async function updateInvoice(
  db: Db,
  workspaceId: string,
  id: string,
  parsed: unknown,
  res: Response
): Promise<void> {
  const invoice = await db.invoice.findFirst({ where: { id, workspaceId, deletedAt: null } });
  if (!invoice) return legacyError(res, 'Invoice not found', 404);
  if (parsed === INVALID_JSON) return legacyError(res, 'Invalid JSON body', 400);

  // invoiceNumber and amountPaid are the system's to set.
  const fields = stripProtectedFields(parsed, ['invoiceNumber', 'amountPaid']);
  const { title, notes, terms, dueDate, status, lineItems } = fields as {
    title?: string;
    notes?: string;
    terms?: string;
    dueDate?: string;
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

  const data: Prisma.InvoiceUpdateInput = {};
  if (title !== undefined) data.title = title;
  if (notes !== undefined) data.notes = notes;
  if (terms !== undefined) data.terms = terms;
  if (dueDate !== undefined) {
    if (isNaN(new Date(dueDate).getTime())) return legacyError(res, 'Invalid due date', 400);
    data.dueDate = new Date(dueDate);
  }

  // Paid and voided invoices only change status.
  const changesContent =
    title !== undefined ||
    notes !== undefined ||
    terms !== undefined ||
    dueDate !== undefined ||
    lineItems !== undefined;
  if (LOCKED.includes(invoice.status) && changesContent) {
    return legacyError(res, 'Cannot modify a paid or voided invoice', 400);
  }

  if (status !== undefined) {
    const allowed = TRANSITIONS[invoice.status];
    if (!allowed || !allowed.includes(status)) {
      return legacyError(res, 'Invalid status transition', 400);
    }
    // Leaving draft: a GST invoice must carry Rule 46's details. The check
    // reads the stored invoice, so new lines and the status change go in
    // separate requests.
    if (invoice.status === 'draft') {
      if (lineItems) {
        return legacyError(res, 'Change the lines and the status in separate requests', 400);
      }
      try {
        await assertReadyToIssue(db, workspaceId, id);
      } catch (error) {
        if (error instanceof CoreError) return legacyError(res, describeCoreError(error), 422);
        throw error;
      }
    }
    // The status has to agree with the money recorded by payments; PATCH
    // does not move amountPaid, so it cannot make an unpaid invoice paid.
    const paid = toNumber(invoice.amountPaid);
    const total = toNumber(invoice.total);
    if (status === 'paid' && paid < total) {
      return legacyError(res, 'Record a payment for the full amount before marking it paid', 400);
    }
    if (status === 'partial' && (paid <= 0 || paid >= total)) {
      return legacyError(res, 'Only an invoice with a part payment recorded is partial', 400);
    }
    if (status === 'voided') {
      const completed = await db.payment.count({
        where: { invoiceId: id, workspaceId, status: 'completed' },
      });
      if (completed > 0) {
        return legacyError(res, 'Refund the completed payments before voiding this invoice', 400);
      }
    }
    data.status = status;
    if ((status === 'paid' || status === 'partial') && !invoice.paidAt) data.paidAt = new Date();
    if (status === 'voided') data.voidedAt = new Date();
    if (status === 'sent') data.sentAt = new Date();
  }

  if (lineItems) {
    if (LOCKED.includes(invoice.status)) {
      return legacyError(res, `Cannot modify line items on a ${invoice.status} invoice`, 400);
    }
    if (lineItems.length > MAX_LINE_ITEMS) {
      return legacyError(res, 'Maximum 100 line items allowed', 400);
    }
    const invalid = lineItemProblem(lineItems, 'invoice');
    if (invalid) return legacyError(res, invalid, 400);

    // A GST workspace prices with the engine; an issued GST invoice is
    // corrected with a credit note, not edited.
    let gst: PricedGstInvoice | null;
    try {
      const client = await db.client.findFirstOrThrow({
        where: { id: invoice.clientId, workspaceId },
      });
      gst = await priceForWorkspace(db, workspaceId, {
        client,
        lines: gstLines(lineItems),
        discountAmount: invoice.discountValue ? toNumber(invoice.discountValue) : 0,
        placeOfSupply: invoice.placeOfSupply,
        reverseCharge: invoice.reverseCharge,
      });
    } catch (error) {
      if (error instanceof CoreError) return legacyError(res, describeCoreError(error), 422);
      throw error;
    }
    if (gst && invoice.status !== 'draft') {
      return legacyError(res, 'An issued GST invoice cannot be edited; issue a credit note', 422);
    }

    const { lines, subtotal, taxTotal } = priceLines(lineItems);
    // The discount comes off before tax (shared with the dashboard).
    const priced = applyDiscount(
      { subtotal, taxTotal },
      invoice.discountType,
      invoice.discountValue ? toNumber(invoice.discountValue) : 0
    );
    const total = gst ? gst.invoice.total : priced.total;
    if (gst) {
      Object.assign(data, gstInvoiceColumns(gst));
    } else {
      Object.assign(data, {
        subtotal,
        taxTotal: priced.taxTotal,
        discountAmount: priced.discountAmount,
        total,
      });
    }
    const replacement = gst
      ? gst.lines.map((line) => ({ ...line, invoiceId: id }))
      : lines.map((line) => ({
          ...line,
          invoiceId: id,
          taxRate: line.taxRate != null ? line.taxRate : null,
        }));
    // The amount paid as stored now, not as read at the start of the request.
    const fresh = await db.invoice.findFirst({
      where: { id, workspaceId },
      select: { amountPaid: true },
    });
    data.amountDue = Math.max(0, total - toNumber(fresh?.amountPaid));

    const updated = await db.$transaction(async (tx) => {
      await tx.invoiceLineItem.deleteMany({ where: { invoiceId: id, invoice: { workspaceId } } });
      await tx.invoiceLineItem.createMany({ data: replacement });
      return tx.invoice.update({ where: { id, workspaceId }, data, include: DOCUMENT_INCLUDE });
    });
    await recordUpdate(db, id);
    return legacyJson(res, formatInvoice(updated, { voidedAt: true }));
  }

  const updated = await db.invoice.update({
    where: { id, workspaceId },
    data,
    include: DOCUMENT_INCLUDE,
  });
  await recordUpdate(db, id);
  legacyJson(res, formatInvoice(updated, { voidedAt: true }));
}
