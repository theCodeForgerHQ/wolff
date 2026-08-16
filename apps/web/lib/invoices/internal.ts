/**
 * Internal invoice operations that should NOT be exposed as server actions.
 * This file intentionally does NOT have 'use server' directive.
 */

import { randomBytes } from 'crypto';
import { prisma, type Prisma, withTenantGuard } from '@wolff/database';
import {
  assertReadyToIssue,
  gstInvoiceColumns,
  gstLinesFrom,
  nextCreditNoteNumber,
  nextInvoiceNumber,
  priceForWorkspace,
} from '@wolff/core/invoices';
import { CoreError } from '@wolff/core/errors';

/** Generate a cryptographically secure access token */
function generateAccessToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Generate next invoice number for a workspace (atomic, race-condition safe).
 * A GST workspace numbers per financial year of the issue date.
 */
export async function generateInvoiceNumber(
  workspaceId: string,
  issueDate: Date = new Date()
): Promise<string> {
  return nextInvoiceNumber(withTenantGuard(prisma), workspaceId, issueDate);
}

/**
 * Generate next credit note number for a workspace (atomic, race-condition
 * safe). A GST workspace numbers per financial year, like its invoices.
 */
export async function generateCreditNoteNumber(workspaceId: string): Promise<string> {
  return nextCreditNoteNumber(withTenantGuard(prisma), workspaceId);
}

/**
 * Create invoice from quote without requiring auth context.
 * Used by the public portal when auto-invoice is enabled on quote acceptance,
 * and by POST /api/v1/invoices/from-quote.
 *
 * The invoice is issued ('sent') straight away, except in a GST workspace:
 * there it is priced by the GST engine, created as a draft, and issued only
 * if Rule 46's mandatory fields are present. `issued` says which happened;
 * a draft is left for the owner to complete and send.
 *
 * NOT a server action - only callable from server-side code, not from the client.
 */
export async function createInvoiceFromQuoteInternal(
  quoteId: string,
  workspaceId: string,
  options?: { dueDays?: number }
): Promise<{
  success: boolean;
  invoice?: { id: string; accessToken: string };
  issued?: boolean;
  error?: string;
}> {
  const quote = await prisma.quote.findFirst({
    where: { id: quoteId, workspaceId, deletedAt: null },
    include: {
      lineItems: { orderBy: { sortOrder: 'asc' } },
      client: true,
    },
  });

  if (!quote) {
    return { success: false, error: 'Quote not found' };
  }

  const existingInvoice = await prisma.invoice.findFirst({
    where: { quoteId: quote.id },
  });
  if (existingInvoice) {
    return { success: false, error: 'Invoice already exists for this quote' };
  }

  const guarded = withTenantGuard(prisma);
  let gst: Awaited<ReturnType<typeof priceForWorkspace>>;
  try {
    gst = await priceForWorkspace(guarded, workspaceId, {
      client: quote.client,
      lines: gstLinesFrom(quote.lineItems),
      discountAmount: Number(quote.discountAmount),
    });
  } catch (error) {
    if (error instanceof CoreError) return { success: false, error: error.message };
    throw error;
  }

  const invoiceNumber = await generateInvoiceNumber(workspaceId);
  const dueDays = options?.dueDays ?? 30;
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + dueDays);

  const invoice = await prisma.$transaction(async (tx) => {
    const newInvoice = await tx.invoice.create({
      data: {
        workspaceId,
        clientId: quote.clientId,
        projectId: quote.projectId,
        quoteId: quote.id,
        invoiceNumber,
        title: quote.title || 'Invoice',
        accessToken: generateAccessToken(),
        // Auto-generated from quote acceptance: ready for client payment. A GST
        // invoice waits in draft for the Rule 46 check below.
        status: gst ? 'draft' : 'sent',
        sentAt: gst ? null : new Date(), // Bug #8: Set sentAt when auto-creating with 'sent' status
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
        settings: {} as unknown as Prisma.InputJsonValue,
        lineItems: {
          create: gst
            ? gst.lines
            : quote.lineItems.map((item, idx) => ({
                name: item.name,
                description: item.description,
                quantity: item.quantity,
                rate: item.rate,
                amount: item.amount,
                taxRate: item.taxRate,
                taxAmount: item.taxAmount,
                sortOrder: idx,
              })),
        },
      },
      select: { id: true, accessToken: true },
    });

    await tx.quote.update({
      where: { id: quote.id },
      data: { status: 'converted' },
    });

    await tx.quoteEvent.create({
      data: {
        quoteId: quote.id,
        eventType: 'converted_to_invoice',
        actorType: 'system',
        metadata: { invoiceId: newInvoice.id, trigger: 'auto_convert' },
      },
    });

    await tx.invoiceEvent.create({
      data: {
        invoiceId: newInvoice.id,
        eventType: 'created',
        actorType: 'system',
        metadata: { fromQuoteId: quote.id, trigger: 'auto_convert' },
      },
    });

    return newInvoice;
  });

  const issued = gst ? await issueIfReady(guarded, workspaceId, invoice.id) : true;
  return {
    success: true,
    issued,
    invoice: { id: invoice.id, accessToken: invoice.accessToken },
  };
}

/** Moves a GST draft to 'sent' if Rule 46 passes; records why if not. */
async function issueIfReady(
  db: ReturnType<typeof withTenantGuard>,
  workspaceId: string,
  invoiceId: string
): Promise<boolean> {
  try {
    await assertReadyToIssue(db, workspaceId, invoiceId);
  } catch (error) {
    if (!(error instanceof CoreError)) throw error;
    await prisma.invoiceEvent.create({
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
  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { status: 'sent', sentAt: new Date() },
  });
  return true;
}
