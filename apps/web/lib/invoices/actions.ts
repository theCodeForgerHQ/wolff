'use server';

import { revalidatePath } from 'next/cache';
import { prisma, type Prisma } from '@wolff/database';
import {
  assertGstSupported,
  gstInvoiceColumns,
  gstLinesFrom,
  isGstWorkspace,
  loadGstProfile,
  priceForWorkspace,
  priceGstInvoice,
  type GstInvoiceLineInput,
  type PricedGstInvoice,
  type StoredGstLine,
} from '@wolff/core/invoices';
import { CoreError } from '@wolff/core/errors';
import { getCurrentUserWorkspace } from '@/lib/workspace/get-current-workspace';
import type { CreateInvoiceData, UpdateInvoiceData } from './types';
import { toNumber } from '@/lib/utils';
import { ROUTES } from '@/lib/routes';
import { generateInvoiceNumber } from './internal';
import { domainEvents } from '@/lib/events/emitter';
import { requestAiIndexing, requestPdfRender } from '@wolff/core/outbox';
import {
  calculateTotals,
  describeCoreError,
  generateAccessToken,
  getActiveWorkspace,
  gstDb,
  issueBlocker,
} from './action-helpers';

/**
 * Create a new invoice
 */
// Low #57: Both calls are cached via React.cache() — no actual redundant DB query
export async function createInvoice(data: CreateInvoiceData) {
  const { userId, workspace } = await getActiveWorkspace();
  const { role } = await getCurrentUserWorkspace();

  // Bug #456: RBAC — viewers cannot create invoices
  if (role === 'viewer') {
    return { success: false, error: 'Insufficient permissions: viewers cannot create invoices' };
  }

  // MEDIUM #13: Basic input validation
  if (!data.clientId || typeof data.clientId !== 'string') {
    return { success: false, error: 'Client is required' };
  }
  if (!data.lineItems || !Array.isArray(data.lineItems) || data.lineItems.length === 0) {
    return { success: false, error: 'At least one line item is required' };
  }

  // Verify client belongs to workspace
  const client = await prisma.client.findFirst({
    where: { id: data.clientId, workspaceId: workspace.id, deletedAt: null },
  });
  if (!client) {
    return { success: false, error: 'Client not found' };
  }

  // GST workspaces: priced by the engine, numbered per FY.
  const gstProfile = await loadGstProfile(gstDb, workspace.id);
  const isGst = isGstWorkspace(gstProfile);
  if (isGst) {
    try {
      assertGstSupported(gstProfile);
    } catch (error) {
      if (error instanceof CoreError) return { success: false, error: error.message };
      throw error;
    }
    if (data.discountType && data.discountValue) {
      return {
        success: false,
        error: 'GST invoices take discounts per line, before tax; remove the invoice discount',
      };
    }
  }

  // Use custom invoice number if provided, otherwise auto-generate
  let invoiceNumber: string;
  if (data.invoiceNumber) {
    // Check uniqueness
    const existing = await prisma.invoice.findFirst({
      where: { workspaceId: workspace.id, invoiceNumber: data.invoiceNumber },
    });
    if (existing) {
      return { success: false, error: 'Invoice number already exists' };
    }
    invoiceNumber = data.invoiceNumber;
  } else {
    invoiceNumber = await generateInvoiceNumber(workspace.id);
  }

  // Determine currency: use provided value, or fall back to workspace BusinessProfile, then 'USD'
  let currency = data.currency || 'USD';
  if (!data.currency) {
    const profile = await prisma.businessProfile.findUnique({
      where: { workspaceId: workspace.id },
      select: { currency: true },
    });
    currency = profile?.currency || 'USD';
  }

  // Validate line item values
  for (const item of data.lineItems) {
    if (!Number.isFinite(item.rate) || item.rate < 0 || item.rate > 1_000_000) {
      return { success: false, error: 'Line item rate must be between 0 and 1,000,000' };
    }
    if (!Number.isFinite(item.quantity) || item.quantity < 0 || item.quantity > 1_000_000) {
      return { success: false, error: 'Line item quantity must be between 0 and 1,000,000' };
    }
  }

  // Bug #17: Validate discount values before calculating totals
  if (data.discountType === 'percentage' && data.discountValue != null) {
    if (data.discountValue < 0 || data.discountValue > 100) {
      return { success: false, error: 'Discount percentage must be between 0 and 100' };
    }
  }
  if (data.discountType === 'fixed' && data.discountValue != null) {
    if (data.discountValue < 0) {
      return { success: false, error: 'Discount amount cannot be negative' };
    }
    // Cap fixed discount at subtotal (calculateTotals also clamps, but reject early for clarity)
    const preliminarySubtotal = data.lineItems.reduce(
      (sum, item) => sum + Math.round(item.quantity * item.rate * 100) / 100,
      0
    );
    if (data.discountValue > preliminarySubtotal) {
      data.discountValue = preliminarySubtotal;
    }
  }

  let gst: PricedGstInvoice | null;
  try {
    gst = isGst
      ? priceGstInvoice({
          profile: gstProfile,
          client,
          lines: data.lineItems.map((item) => ({
            name: item.name,
            description: item.description || null,
            quantity: Math.round(item.quantity * 100) / 100,
            rate: item.rate,
            gstRate: item.taxRate ?? 0,
            hsnSac: item.hsnSac?.trim() || null,
            itemType: item.itemType,
          })),
        })
      : null;
  } catch (error) {
    if (error instanceof CoreError) return { success: false, error: describeCoreError(error) };
    throw error;
  }

  const generic = calculateTotals(data.lineItems, {
    type: data.discountType,
    value: data.discountValue,
  });
  const { subtotal, taxTotal, discountAmount, total } = gst
    ? { ...gst.invoice, discountAmount: 0 }
    : generic;

  const genericLineItems = data.lineItems.map((item, index) => ({
    name: item.name,
    description: item.description || null,
    quantity: Math.round(item.quantity * 100) / 100,
    rate: item.rate,
    amount: Math.round(item.quantity * item.rate * 100) / 100,
    taxRate: item.taxRate || null,
    taxAmount: item.taxRate
      ? Math.round(item.quantity * item.rate * (item.taxRate / 100) * 100) / 100
      : 0,
    sortOrder: index,
  }));
  const lineItems = gst ? gst.lines : genericLineItems;

  // A GST invoice is created as a draft and leaves draft only after the
  // Rule 46 check below.
  const wantsSent = data.isDraft === false;
  const invoice = await prisma.$transaction(async (tx) => {
    const created = await tx.invoice.create({
      data: {
        workspaceId: workspace.id,
        clientId: data.clientId,
        projectId: data.projectId || null,
        invoiceNumber,
        title: data.title,
        status: wantsSent && !gst ? 'sent' : 'draft',
        ...(gst && {
          placeOfSupply: gst.invoice.placeOfSupply,
          supplyType: gst.invoice.supplyType,
          reverseCharge: gst.invoice.reverseCharge,
          supplierGstin: gst.invoice.supplierGstin,
          recipientGstin: gst.invoice.recipientGstin,
          taxBreakup: gst.invoice.taxBreakup as Prisma.InputJsonValue,
        }),
        currency,
        accessToken: generateAccessToken(),
        issueDate: new Date(),
        dueDate: new Date(data.dueDate),
        subtotal,
        discountType: data.discountType || null,
        discountValue: data.discountValue ?? null,
        discountAmount,
        taxTotal,
        total,
        amountDue: total,
        notes: data.notes || null,
        terms: data.terms || null,
        internalNotes: data.internalNotes || null,
        settings: {} as unknown as Prisma.InputJsonValue,
        lineItems: {
          create: lineItems,
        },
      },
      include: {
        lineItems: true,
        client: true,
        project: true,
      },
    });
    await requestAiIndexing(tx, {
      workspaceId: workspace.id,
      sourceType: 'invoice',
      sourceId: created.id,
    });
    if (created.status === 'sent') {
      await requestPdfRender(tx, {
        workspaceId: workspace.id,
        documentType: 'invoice',
        documentId: created.id,
      });
    }
    return created;
  });

  // H01 fix: Create activity event on invoice creation
  await prisma.invoiceEvent.create({
    data: {
      invoiceId: invoice.id,
      eventType: 'created',
      actorId: userId,
      actorType: 'user',
      metadata: {},
    },
  });

  if (gst && wantsSent) {
    const blocker = await issueBlocker(workspace.id, invoice.id);
    if (blocker) {
      revalidatePath(ROUTES.invoices);
      return { success: false, error: `Saved as a draft. ${blocker}`, invoiceId: invoice.id };
    }
    await prisma.$transaction(async (tx) => {
      await tx.invoice.update({
        where: { id: invoice.id },
        data: { status: 'sent', sentAt: new Date() },
      });
      await requestPdfRender(tx, {
        workspaceId: workspace.id,
        documentType: 'invoice',
        documentId: invoice.id,
      });
    });
    invoice.status = 'sent';
  }

  revalidatePath(ROUTES.invoices);

  try {
    domainEvents.emit({
      type: 'invoice.created',
      payload: { invoiceId: invoice.id, workspaceId: workspace.id },
    });
  } catch {}

  return {
    success: true,
    invoice: {
      ...invoice,
      subtotal: toNumber(invoice.subtotal),
      discountValue: invoice.discountValue ? Number(invoice.discountValue) : null,
      discountAmount: toNumber(invoice.discountAmount),
      taxTotal: toNumber(invoice.taxTotal),
      total: toNumber(invoice.total),
      amountPaid: toNumber(invoice.amountPaid),
      amountDue: toNumber(invoice.amountDue),
      lineItems: invoice.lineItems.map((li) => ({
        ...li,
        quantity: toNumber(li.quantity),
        rate: toNumber(li.rate),
        amount: toNumber(li.amount),
        taxRate: li.taxRate ? Number(li.taxRate) : null,
        taxAmount: toNumber(li.taxAmount),
      })),
    },
  };
}

/**
 * Create invoice from an accepted quote
 */
export async function createInvoiceFromQuote(quoteId: string, options?: { dueDays?: number }) {
  const { userId, workspace } = await getActiveWorkspace();
  const { role } = await getCurrentUserWorkspace();

  // Bug #456: RBAC — viewers cannot convert quotes to invoices
  if (role === 'viewer') {
    return { success: false, error: 'Insufficient permissions: viewers cannot create invoices' };
  }

  // Get the quote with line items
  const quote = await prisma.quote.findFirst({
    where: {
      id: quoteId,
      workspaceId: workspace.id,
      deletedAt: null,
    },
    include: {
      lineItems: {
        orderBy: { sortOrder: 'asc' },
      },
      client: true,
    },
  });

  if (!quote) {
    return { success: false, error: 'Quote not found' };
  }

  // Only accepted or sent quotes can be converted to invoices
  const convertibleStatuses = ['accepted', 'sent', 'viewed'];
  if (!convertibleStatuses.includes(quote.status)) {
    return {
      success: false,
      error: `Cannot convert a ${quote.status} quote to an invoice. Quote must be accepted or sent first.`,
    };
  }

  // Bug #123: Validate discount values from source quote
  const discountValue = toNumber(quote.discountValue) || 0;
  let discountAmount = toNumber(quote.discountAmount) || 0;
  const subtotal = toNumber(quote.subtotal);

  // Bug #13: Recalculate discount during quote-to-invoice conversion
  // Recalculate subtotal from actual line items to ensure discount doesn't exceed it
  const lineItemSubtotal = quote.lineItems.reduce((sum, item) => sum + toNumber(item.amount), 0);

  if (quote.discountType === 'percentage') {
    if (discountValue < 0 || discountValue > 100) {
      return { success: false, error: 'Discount percentage must be between 0 and 100' };
    }
    // Recalculate percentage-based discount amount from actual line item subtotal
    discountAmount = Math.round(lineItemSubtotal * (discountValue / 100) * 100) / 100;
  } else {
    // For fixed amount discounts, cap at the actual subtotal
    if (discountAmount < 0) {
      return { success: false, error: 'Discount amount cannot be negative' };
    }
    if (discountAmount > lineItemSubtotal) {
      discountAmount = lineItemSubtotal;
    }
  }

  // GST workspaces: re-price the quote's lines with the engine, so the
  // invoice carries the CGST/SGST/IGST split Rule 46 asks for.
  const gstProfile = await loadGstProfile(gstDb, workspace.id);
  let gst: ReturnType<typeof priceGstInvoice> | null = null;
  if (isGstWorkspace(gstProfile)) {
    try {
      assertGstSupported(gstProfile);
    } catch (error) {
      if (error instanceof CoreError) return { success: false, error: error.message };
      throw error;
    }
    if (discountAmount > 0) {
      return {
        success: false,
        error: 'GST invoices take discounts per line, before tax; remove the quote discount',
      };
    }
    try {
      gst = priceGstInvoice({
        profile: gstProfile,
        client: quote.client,
        lines: quote.lineItems.map((item) => ({
          name: item.name,
          description: item.description,
          quantity: toNumber(item.quantity),
          rate: toNumber(item.rate),
          gstRate: toNumber(item.gstRate ?? item.taxRate),
          hsnSac: item.hsnSac,
          itemType: item.itemType,
        })),
      });
    } catch (error) {
      if (error instanceof CoreError) return { success: false, error: describeCoreError(error) };
      throw error;
    }
  }

  // Calculate due date (configurable, default: 30 days from now)
  const dueDays = options?.dueDays ?? 30;
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + dueDays);

  let invoice;
  try {
    invoice = await prisma.$transaction(async (tx) => {
      // Bug #7: Check for existing invoice INSIDE transaction to prevent race condition
      const existingInvoice = await tx.invoice.findFirst({
        where: { quoteId: quote.id },
      });

      if (existingInvoice) {
        throw new Error('DUPLICATE_INVOICE');
      }

      const invoiceNumber = await generateInvoiceNumber(workspace.id);

      // Create the invoice
      const newInvoice = await tx.invoice.create({
        data: {
          workspaceId: workspace.id,
          clientId: quote.clientId,
          projectId: quote.projectId,
          quoteId: quote.id,
          invoiceNumber,
          title: quote.title || 'Invoice',
          status: 'draft',
          currency: quote.currency,
          issueDate: new Date(),
          dueDate,
          ...(gst
            ? {
                subtotal: gst.invoice.subtotal,
                taxTotal: gst.invoice.taxTotal,
                total: gst.invoice.total,
                amountDue: gst.invoice.total,
                placeOfSupply: gst.invoice.placeOfSupply,
                supplyType: gst.invoice.supplyType,
                reverseCharge: gst.invoice.reverseCharge,
                supplierGstin: gst.invoice.supplierGstin,
                recipientGstin: gst.invoice.recipientGstin,
                taxBreakup: gst.invoice.taxBreakup as Prisma.InputJsonValue,
              }
            : {
                subtotal: lineItemSubtotal,
                discountType: quote.discountType,
                discountValue: quote.discountValue,
                discountAmount: discountAmount,
                taxTotal: quote.taxTotal,
                total: lineItemSubtotal - discountAmount + toNumber(quote.taxTotal),
                amountDue: lineItemSubtotal - discountAmount + toNumber(quote.taxTotal),
              }),
          notes: quote.notes,
          terms: quote.terms,
          settings: {} as unknown as Prisma.InputJsonValue,
          lineItems: {
            create: gst
              ? gst.lines
              : quote.lineItems.map((item: (typeof quote.lineItems)[number]) => ({
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
        include: {
          lineItems: true,
          client: true,
          project: true,
        },
      });

      // Update quote status to converted
      await tx.quote.update({
        where: { id: quote.id },
        data: { status: 'converted' },
      });

      // Log the conversion event on the quote
      await tx.quoteEvent.create({
        data: {
          quoteId: quote.id,
          eventType: 'converted_to_invoice',
          actorId: userId,
          actorType: 'user',
          metadata: { invoiceId: newInvoice.id },
        },
      });

      // H01 fix: Create activity event on the new invoice
      await tx.invoiceEvent.create({
        data: {
          invoiceId: newInvoice.id,
          eventType: 'created',
          actorId: userId,
          actorType: 'user',
          metadata: { fromQuoteId: quote.id },
        },
      });

      return newInvoice;
    });
  } catch (err) {
    if (err instanceof Error && err.message === 'DUPLICATE_INVOICE') {
      return { success: false, error: 'Invoice already exists for this quote' };
    }
    throw err;
  }

  revalidatePath(ROUTES.invoices);
  revalidatePath(ROUTES.quotes);
  revalidatePath(ROUTES.quoteDetail(quoteId));

  try {
    domainEvents.emit({
      type: 'invoice.created',
      payload: { invoiceId: invoice.id, workspaceId: workspace.id },
    });
  } catch {}

  return {
    success: true,
    invoice: {
      ...invoice,
      subtotal: toNumber(invoice.subtotal),
      discountValue: invoice.discountValue ? Number(invoice.discountValue) : null,
      discountAmount: toNumber(invoice.discountAmount),
      taxTotal: toNumber(invoice.taxTotal),
      total: toNumber(invoice.total),
      amountPaid: toNumber(invoice.amountPaid),
      amountDue: toNumber(invoice.amountDue),
      lineItems: invoice.lineItems.map((li) => ({
        ...li,
        quantity: toNumber(li.quantity),
        rate: toNumber(li.rate),
        amount: toNumber(li.amount),
        taxRate: li.taxRate ? Number(li.taxRate) : null,
        taxAmount: toNumber(li.taxAmount),
      })),
    },
  };
}

/**
 * GST price of an edited draft, or null outside a GST workspace. Lines that
 * edit a stored line keep its HSN/SAC and item type unless new ones are
 * given (the editor does not show them yet); with no new lines the stored
 * ones are re-priced.
 */
async function priceDraftForWorkspace(
  workspaceId: string,
  existing: {
    clientId: string;
    placeOfSupply: string | null;
    reverseCharge: boolean;
    lineItems: Array<StoredGstLine & { id: string }>;
  },
  data: UpdateInvoiceData,
  options: { discountAmount: number }
): Promise<PricedGstInvoice | null> {
  const client = await gstDb.client.findFirstOrThrow({
    where: { id: existing.clientId, workspaceId },
  });
  const stored = new Map(existing.lineItems.map((line) => [line.id, line]));
  const lines: GstInvoiceLineInput[] = data.lineItems
    ? data.lineItems.map((item) => {
        const before = item.id ? stored.get(item.id) : undefined;
        return {
          name: item.name,
          description: item.description || null,
          quantity: Math.round(item.quantity * 100) / 100,
          rate: item.rate,
          gstRate: item.taxRate ?? 0,
          hsnSac: item.hsnSac?.trim() || before?.hsnSac || null,
          itemType: item.itemType ?? before?.itemType,
        };
      })
    : gstLinesFrom(existing.lineItems);
  return priceForWorkspace(gstDb, workspaceId, {
    client,
    lines,
    discountAmount: options.discountAmount,
    placeOfSupply: existing.placeOfSupply,
    reverseCharge: existing.reverseCharge,
  });
}

/**
 * Update an existing invoice
 */
export async function updateInvoice(invoiceId: string, data: UpdateInvoiceData) {
  const { workspace } = await getActiveWorkspace();
  const { role } = await getCurrentUserWorkspace();

  // Bug #456: RBAC — viewers cannot update invoices
  if (role === 'viewer') {
    return { success: false, error: 'Insufficient permissions: viewers cannot edit invoices' };
  }

  const existingInvoice = await prisma.invoice.findFirst({
    where: {
      id: invoiceId,
      workspaceId: workspace.id,
      deletedAt: null,
    },
    include: { lineItems: true },
  });

  if (!existingInvoice) {
    return { success: false, error: 'Invoice not found' };
  }

  // Can only update draft invoices
  if (existingInvoice.status !== 'draft') {
    return { success: false, error: 'Can only edit draft invoices' };
  }

  let subtotal = toNumber(existingInvoice.subtotal);
  let taxTotal = toNumber(existingInvoice.taxTotal);
  let discountAmount = toNumber(existingInvoice.discountAmount);
  let total = toNumber(existingInvoice.total);

  // Resolve discount: use provided values, fall back to existing invoice values
  const discountType =
    data.discountType !== undefined
      ? data.discountType
      : (existingInvoice.discountType as 'percentage' | 'fixed' | null);
  const discountValue =
    data.discountValue !== undefined
      ? data.discountValue
      : existingInvoice.discountValue
        ? Number(existingInvoice.discountValue)
        : null;

  if (data.lineItems) {
    for (const item of data.lineItems) {
      if (item.rate < 0) {
        return { success: false, error: 'Line item rate cannot be negative' };
      }
      if (item.quantity < 0) {
        return { success: false, error: 'Line item quantity cannot be negative' };
      }
    }
  }

  // A GST workspace re-prices with the engine whenever amounts change.
  const touchesAmounts =
    Boolean(data.lineItems) || data.discountType !== undefined || data.discountValue !== undefined;
  let gst: PricedGstInvoice | null = null;
  if (touchesAmounts) {
    try {
      gst = await priceDraftForWorkspace(workspace.id, existingInvoice, data, {
        discountAmount: discountType && discountValue ? discountValue : 0,
      });
    } catch (error) {
      if (error instanceof CoreError) return { success: false, error: error.message };
      throw error;
    }
  }

  if (gst) {
    ({ subtotal, taxTotal, total } = gst.invoice);
    discountAmount = 0;
  } else if (data.lineItems) {
    const totals = calculateTotals(data.lineItems, { type: discountType, value: discountValue });
    subtotal = totals.subtotal;
    taxTotal = totals.taxTotal;
    discountAmount = totals.discountAmount;
    total = totals.total;
  } else if (data.discountType !== undefined || data.discountValue !== undefined) {
    // Line items didn't change but discount did — recalculate with existing line items
    const existingItems = existingInvoice.lineItems.map((li) => ({
      quantity: toNumber(li.quantity),
      rate: toNumber(li.rate),
      taxRate: li.taxRate ? Number(li.taxRate) : undefined,
    }));
    const totals = calculateTotals(existingItems, { type: discountType, value: discountValue });
    subtotal = totals.subtotal;
    taxTotal = totals.taxTotal;
    discountAmount = totals.discountAmount;
    total = totals.total;
  }

  const invoice = await prisma.$transaction(async (tx) => {
    // Delete existing line items if updating
    if (data.lineItems) {
      await tx.invoiceLineItem.deleteMany({
        where: { invoiceId },
      });
    }

    const updated = await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        projectId: data.projectId !== undefined ? data.projectId : undefined,
        title: data.title,
        currency: data.currency,
        dueDate: data.dueDate ? new Date(data.dueDate) : undefined,
        notes: data.notes,
        terms: data.terms,
        internalNotes: data.internalNotes,
        // Always persist discount fields if they changed
        ...(data.discountType !== undefined && { discountType: data.discountType || null }),
        ...(data.discountValue !== undefined && { discountValue: data.discountValue ?? null }),
        ...(gst && gstInvoiceColumns(gst)),
        ...((data.lineItems ||
          data.discountType !== undefined ||
          data.discountValue !== undefined) && {
          subtotal,
          discountAmount,
          taxTotal,
          total,
          amountDue: Math.max(0, total - toNumber(existingInvoice.amountPaid)),
        }),
        ...(data.lineItems && {
          lineItems: {
            create: gst
              ? gst.lines
              : data.lineItems.map((item, index) => ({
                  name: item.name,
                  description: item.description || null,
                  quantity: item.quantity,
                  rate: item.rate,
                  amount: Math.round(item.quantity * item.rate * 100) / 100,
                  taxRate: item.taxRate || null,
                  taxAmount: item.taxRate
                    ? Math.round(item.quantity * item.rate * (item.taxRate / 100) * 100) / 100
                    : 0,
                  sortOrder: index,
                })),
          },
        }),
      },
      include: {
        lineItems: true,
        client: true,
      },
    });
    await requestAiIndexing(tx, {
      workspaceId: workspace.id,
      sourceType: 'invoice',
      sourceId: invoiceId,
    });
    return updated;
  });

  revalidatePath(ROUTES.invoices);
  revalidatePath(ROUTES.invoiceDetail(invoiceId));

  return { success: true, invoice };
}

/**
 * Delete (soft delete) an invoice
 */
export async function deleteInvoice(invoiceId: string) {
  const { workspace } = await getActiveWorkspace();
  const { role } = await getCurrentUserWorkspace();

  if (role === 'viewer') {
    return { success: false, error: 'Insufficient permissions: viewers cannot delete invoices' };
  }

  const invoice = await prisma.invoice.findFirst({
    where: {
      id: invoiceId,
      workspaceId: workspace.id,
      deletedAt: null,
    },
  });

  if (!invoice) {
    return { success: false, error: 'Invoice not found' };
  }

  // Can only delete draft invoices
  if (invoice.status !== 'draft') {
    return { success: false, error: 'Can only delete draft invoices. Use void for sent invoices.' };
  }

  await prisma.$transaction(async (tx) => {
    await tx.invoice.update({
      where: { id: invoiceId },
      data: { deletedAt: new Date() },
    });
    // The AI service drops a soft-deleted invoice from its index.
    await requestAiIndexing(tx, {
      workspaceId: workspace.id,
      sourceType: 'invoice',
      sourceId: invoiceId,
    });
  });

  revalidatePath(ROUTES.invoices);

  return { success: true };
}

/**
 * Duplicate an invoice
 */
export async function duplicateInvoice(invoiceId: string) {
  const { workspace } = await getActiveWorkspace();
  const { role } = await getCurrentUserWorkspace();

  // Bug #456: RBAC — viewers cannot duplicate invoices
  if (role === 'viewer') {
    return { success: false, error: 'Insufficient permissions: viewers cannot duplicate invoices' };
  }

  const original = await prisma.invoice.findFirst({
    where: {
      id: invoiceId,
      workspaceId: workspace.id,
      deletedAt: null,
    },
    include: {
      lineItems: {
        orderBy: { sortOrder: 'asc' },
      },
    },
  });

  if (!original) {
    return { success: false, error: 'Invoice not found' };
  }

  // A GST copy is re-priced from its lines, so it carries the split and the
  // fields Rule 46 needs, like any new GST invoice.
  let gst: PricedGstInvoice | null;
  try {
    const client = await gstDb.client.findFirstOrThrow({
      where: { id: original.clientId, workspaceId: workspace.id },
    });
    gst = await priceForWorkspace(gstDb, workspace.id, {
      client,
      lines: gstLinesFrom(original.lineItems),
      discountAmount: toNumber(original.discountAmount),
      placeOfSupply: original.placeOfSupply,
      reverseCharge: original.reverseCharge,
    });
  } catch (error) {
    if (error instanceof CoreError) return { success: false, error: error.message };
    throw error;
  }

  const invoiceNumber = await generateInvoiceNumber(workspace.id);

  // Set new due date 30 days from now
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 30);

  const duplicate = await prisma.invoice.create({
    data: {
      workspaceId: workspace.id,
      clientId: original.clientId,
      projectId: original.projectId,
      invoiceNumber,
      title: `${original.title || 'Invoice'} (Copy)`,
      status: 'draft',
      currency: original.currency,
      accessToken: generateAccessToken(),
      issueDate: new Date(),
      dueDate,
      ...(gst
        ? { ...gstInvoiceColumns(gst), amountDue: gst.invoice.total }
        : {
            subtotal: original.subtotal,
            discountType: original.discountType,
            discountValue: original.discountValue,
            discountAmount: original.discountAmount,
            taxTotal: original.taxTotal,
            total: original.total,
            amountDue: original.total,
          }),
      amountPaid: 0,
      notes: original.notes,
      terms: original.terms,
      settings: original.settings as Prisma.InputJsonValue,
      lineItems: {
        create: gst
          ? gst.lines
          : original.lineItems.map((item: (typeof original.lineItems)[number]) => ({
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
  });

  revalidatePath(ROUTES.invoices);

  return { success: true, invoiceId: duplicate.id };
}
