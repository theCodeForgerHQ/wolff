'use server';

import { prisma, type Prisma } from '@wolff/database';
import type { InvoiceDocument, InvoiceListItem, InvoiceStatus } from './types';
import { toNumber } from '@/lib/utils';
import { getActiveWorkspace } from './action-helpers';

/**
 * Get a single invoice by ID
 */
export async function getInvoice(invoiceId: string): Promise<InvoiceDocument | null> {
  const { workspace } = await getActiveWorkspace();

  const invoice = await prisma.invoice.findFirst({
    where: {
      id: invoiceId,
      workspaceId: workspace.id,
      deletedAt: null,
    },
    include: {
      lineItems: {
        orderBy: { sortOrder: 'asc' },
      },
      client: true,
      project: true,
      payments: true,
    },
  });

  if (!invoice) {
    return null;
  }

  const settings = invoice.settings as Record<string, unknown>;

  return {
    id: invoice.id,
    workspaceId: invoice.workspaceId,
    clientId: invoice.clientId,
    projectId: invoice.projectId,
    quoteId: invoice.quoteId,
    invoiceNumber: invoice.invoiceNumber,
    accessToken: invoice.accessToken,
    status: invoice.status as InvoiceStatus,
    title: invoice.title || 'Invoice',
    currency: invoice.currency,
    issueDate: invoice.issueDate.toISOString().split('T')[0] ?? '',
    dueDate: invoice.dueDate.toISOString().split('T')[0] ?? '',
    lineItems: invoice.lineItems.map((item: (typeof invoice.lineItems)[number]) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      quantity: toNumber(item.quantity),
      rate: toNumber(item.rate),
      amount: toNumber(item.amount),
      taxRate: item.taxRate ? Number(item.taxRate) : null,
      taxAmount: toNumber(item.taxAmount),
      sortOrder: item.sortOrder,
    })),
    settings: {
      currency: (settings.currency as string) ?? 'USD',
      showLineItemPrices: (settings.showLineItemPrices as boolean) ?? true,
      paymentTerms: (settings.paymentTerms as string) ?? 'net30',
      lateFeeEnabled: (settings.lateFeeEnabled as boolean) ?? false,
      lateFeeType: (settings.lateFeeType as 'percentage' | 'fixed') ?? 'percentage',
      lateFeeValue: (settings.lateFeeValue as number) ?? 0,
      reminderEnabled: (settings.reminderEnabled as boolean) ?? true,
      reminderDays: (settings.reminderDays as number[]) ?? [7, 3, 1],
    },
    totals: {
      subtotal: toNumber(invoice.subtotal),
      discountType: invoice.discountType as 'percentage' | 'fixed' | null,
      discountValue: invoice.discountValue ? Number(invoice.discountValue) : null,
      discountAmount: toNumber(invoice.discountAmount),
      taxTotal: toNumber(invoice.taxTotal),
      total: toNumber(invoice.total),
      amountPaid: toNumber(invoice.amountPaid),
      amountDue: toNumber(invoice.amountDue),
    },
    notes: invoice.notes || '',
    terms: invoice.terms || '',
    internalNotes: invoice.internalNotes || '',
    client: invoice.client
      ? {
          id: invoice.client.id,
          name: invoice.client.name,
          email: invoice.client.email,
          company: invoice.client.company,
        }
      : null,
  };
}

/**
 * Get all invoices for the current workspace
 */
export async function getInvoices(filters?: {
  status?: InvoiceStatus;
  clientId?: string;
  search?: string;
}): Promise<InvoiceListItem[]> {
  const { workspace } = await getActiveWorkspace();

  const where: Prisma.InvoiceWhereInput = {
    workspaceId: workspace.id,
    deletedAt: null,
    ...(filters?.status && { status: filters.status }),
    ...(filters?.clientId && { clientId: filters.clientId }),
    ...(filters?.search && {
      OR: [
        { invoiceNumber: { contains: filters.search, mode: 'insensitive' } },
        { title: { contains: filters.search, mode: 'insensitive' } },
        { client: { name: { contains: filters.search, mode: 'insensitive' } } },
      ],
    }),
  };

  const invoices = await prisma.invoice.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      client: {
        select: {
          id: true,
          name: true,
          email: true,
          company: true,
        },
      },
    },
  });

  const now = new Date();

  return invoices.map((invoice) => {
    const dueDate = new Date(invoice.dueDate);
    const isOverdue =
      invoice.status !== 'paid' &&
      invoice.status !== 'voided' &&
      invoice.status !== 'draft' &&
      dueDate < now;

    return {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      // Bug #176: Partially-paid overdue invoices should also show as overdue
      status: (isOverdue ? 'overdue' : invoice.status) as InvoiceStatus,
      title: invoice.title || 'Invoice',
      currency: invoice.currency,
      issueDate: invoice.issueDate.toISOString().split('T')[0] ?? '',
      dueDate: invoice.dueDate.toISOString().split('T')[0] ?? '',
      total: toNumber(invoice.total),
      amountPaid: toNumber(invoice.amountPaid),
      amountDue: toNumber(invoice.amountDue),
      accessToken: invoice.accessToken ?? null,
      client: {
        id: invoice.client?.id ?? '',
        name: invoice.client?.name ?? 'Unknown Client',
        email: invoice.client?.email ?? null,
        company: invoice.client?.company ?? null,
      },
      isOverdue,
      isRecurring: invoice.isRecurring,
    };
  });
}
