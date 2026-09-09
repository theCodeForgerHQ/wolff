import { randomBytes } from 'node:crypto';
import type { Prisma } from '@wolff/database';
import type { Db, DbTx } from '../context';
import { CoreError } from '../errors';
import { requestPdfRender } from '../outbox';
import {
  allocateInvoiceNumber,
  assertReadyToIssue,
  gstInvoiceColumns,
  gstLinesFrom,
  priceForWorkspace,
} from './gst';

export interface InvoiceFromQuoteResult {
  success: boolean;
  invoice?: { id: string; accessToken: string };
  /** False when a GST invoice was left in draft because Rule 46 failed. */
  issued?: boolean;
  error?: string;
}

/** A refusal with its reasons, as one message ("Rule 46: GSTIN missing; ..."). */
export function describeCoreError(error: CoreError): string {
  const reasons = error.details ? Object.values(error.details).flat() : [];
  return reasons.length > 0 ? `${error.message}: ${reasons.join('; ')}` : error.message;
}

/**
 * Creates the invoice for a quote of the workspace and marks the quote
 * converted. Used when the client accepts a quote on the portal (auto
 * invoice) and by `POST /v1/invoices/from-quote/:quoteId`.
 *
 * The invoice is issued ('sent') straight away, except in a GST workspace:
 * there it is priced by the GST engine, created as a draft, and issued only
 * if Rule 46's mandatory fields are present. `issued` says which happened.
 * A quote already invoiced, or one of another workspace, is refused.
 */
export async function createInvoiceFromQuote(
  db: Db,
  workspaceId: string,
  quoteId: string,
  options: { dueDays?: number } = {}
): Promise<InvoiceFromQuoteResult> {
  const quote = await db.quote.findFirst({
    where: { id: quoteId, workspaceId, deletedAt: null },
    include: { lineItems: { orderBy: { sortOrder: 'asc' } }, client: true },
  });
  if (!quote) return { success: false, error: 'Quote not found' };
  const source = quote;

  let gst: Awaited<ReturnType<typeof priceForWorkspace>>;
  try {
    gst = await priceForWorkspace(db, workspaceId, {
      client: quote.client,
      lines: gstLinesFrom(quote.lineItems),
      discountAmount: Number(quote.discountAmount),
    });
  } catch (error) {
    if (error instanceof CoreError) return { success: false, error: describeCoreError(error) };
    throw error;
  }

  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + (options.dueDays ?? 30));

  // The check, the number and the insert share one transaction: a refused
  // or failed insert takes its number back, and a concurrent conversion of
  // the same quote loses on the quoteId unique key instead of a 500.
  const invoice = await db
    .$transaction(async (tx) => {
      const existingInvoice = await tx.invoice.findFirst({
        where: { quoteId: quote.id, workspaceId },
        select: { id: true },
      });
      if (existingInvoice) return null;
      const invoiceNumber = await allocateInvoiceNumber(tx, workspaceId);
      return createFromQuote(tx, invoiceNumber);
    })
    .catch((error: unknown) => {
      if (isQuoteUniqueViolation(error)) return null;
      throw error;
    });
  if (!invoice) return { success: false, error: 'Invoice already exists for this quote' };

  const issued = gst ? await issueIfReady(db, workspaceId, invoice.id) : true;
  return { success: true, issued, invoice };

  async function createFromQuote(tx: DbTx, invoiceNumber: string) {
    const quote = source;
    const created = await tx.invoice.create({
      data: {
        workspaceId,
        clientId: quote.clientId,
        projectId: quote.projectId,
        quoteId: quote.id,
        invoiceNumber,
        title: quote.title || 'Invoice',
        currency: quote.currency,
        accessToken: randomBytes(32).toString('hex'),
        // Ready for the client to pay. A GST invoice waits in draft for the
        // Rule 46 check below.
        status: gst ? 'draft' : 'sent',
        sentAt: gst ? null : new Date(),
        issueDate: new Date(),
        dueDate,
        ...(gst
          ? { ...gstInvoiceColumns(gst), amountDue: gst.invoice.total }
          : {
              subtotal: quote.subtotal,
              discountType: quote.discountType,
              discountValue: quote.discountValue,
              discountAmount: quote.discountAmount,
              taxTotal: quote.taxTotal,
              total: quote.total,
              amountDue: quote.total,
            }),
        notes: quote.notes,
        terms: quote.terms,
        settings: {} as Prisma.InputJsonValue,
        lineItems: {
          create: gst
            ? gst.lines
            : quote.lineItems.map((item, index) => ({
                name: item.name,
                description: item.description,
                quantity: item.quantity,
                rate: item.rate,
                amount: item.amount,
                taxRate: item.taxRate,
                taxAmount: item.taxAmount,
                sortOrder: index,
              })),
        },
      },
      select: { id: true, accessToken: true },
    });

    await tx.quote.update({
      where: { id: quote.id, workspaceId },
      data: { status: 'converted' },
    });
    await tx.quoteEvent.create({
      data: {
        quoteId: quote.id,
        eventType: 'converted_to_invoice',
        actorType: 'system',
        metadata: { invoiceId: created.id, trigger: 'auto_convert' },
      },
    });
    await tx.invoiceEvent.create({
      data: {
        invoiceId: created.id,
        eventType: 'created',
        actorType: 'system',
        metadata: { fromQuoteId: quote.id, trigger: 'auto_convert' },
      },
    });
    if (!gst) {
      await requestPdfRender(tx, { workspaceId, documentType: 'invoice', documentId: created.id });
    }
    return created;
  }
}

/** True for the unique violation of invoices.quote_id (one invoice per quote). */
function isQuoteUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const known = error as { code?: string; meta?: unknown; message?: string };
  if (known.code !== 'P2002') return false;
  const where = `${JSON.stringify(known.meta ?? {})} ${known.message ?? ''}`;
  return where.includes('quote_id') || where.includes('quoteId');
}

/** Moves a GST draft to 'sent' if Rule 46 passes; records why if not. */
async function issueIfReady(db: Db, workspaceId: string, invoiceId: string): Promise<boolean> {
  try {
    await assertReadyToIssue(db, workspaceId, invoiceId);
  } catch (error) {
    if (!(error instanceof CoreError)) throw error;
    await db.invoiceEvent.create({
      data: {
        invoiceId,
        eventType: 'auto_send_blocked',
        actorType: 'system',
        metadata: {
          reason: error.message,
          details: (error.details ?? {}) as Prisma.InputJsonValue,
        },
      },
    });
    return false;
  }
  await db.$transaction(async (tx) => {
    await tx.invoice.update({
      where: { id: invoiceId, workspaceId },
      data: { status: 'sent', sentAt: new Date() },
    });
    await requestPdfRender(tx, { workspaceId, documentType: 'invoice', documentId: invoiceId });
  });
  return true;
}
