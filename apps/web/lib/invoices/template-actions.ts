'use server';

import { revalidatePath } from 'next/cache';
import { prisma, type Prisma } from '@wolff/database';
import { getCurrentUserWorkspace } from '@/lib/workspace/get-current-workspace';
import { ROUTES } from '@/lib/routes';
import { getActiveWorkspace } from './action-helpers';

// ============================================
// INVOICE TEMPLATES
// ============================================

export interface InvoiceTemplateLineItem {
  id: string;
  name: string;
  description: string;
  rate: number;
  qty: number;
  taxable: boolean;
}

export interface InvoiceTemplateListItem {
  id: string;
  name: string;
  description: string;
  paymentTerms: string;
  currency: string;
  lineItems: InvoiceTemplateLineItem[];
  notes: string;
  terms: string;
  usageCount: number;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export async function getInvoiceTemplates(filter?: { search?: string; page?: number }) {
  const { workspace } = await getActiveWorkspace();

  const page = filter?.page ?? 1;
  const limit = 10;
  const skip = (page - 1) * limit;

  const where = {
    workspaceId: workspace.id,
    deletedAt: null,
    ...(filter?.search ? { name: { contains: filter.search, mode: 'insensitive' as const } } : {}),
  };

  const [templates, total] = await Promise.all([
    prisma.invoiceTemplate.findMany({
      where,
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
      skip,
      take: limit,
    }),
    prisma.invoiceTemplate.count({ where }),
  ]);

  const data: InvoiceTemplateListItem[] = templates.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description ?? '',
    paymentTerms: t.paymentTerms,
    currency: t.currency,
    lineItems:
      ((typeof t.lineItems === 'string'
        ? JSON.parse(t.lineItems)
        : t.lineItems) as InvoiceTemplateLineItem[]) ?? [],
    notes: t.notes ?? '',
    terms: t.terms ?? '',
    usageCount: t.usageCount,
    isDefault: t.isDefault,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  }));

  return {
    data,
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function createInvoiceTemplate(data: {
  name: string;
  description?: string;
  paymentTerms?: string;
  currency?: string;
  lineItems?: InvoiceTemplateLineItem[];
  notes?: string;
  terms?: string;
  isDefault?: boolean;
}) {
  const { workspace } = await getActiveWorkspace();
  const { role } = await getCurrentUserWorkspace();
  if (role === 'viewer') {
    return { success: false, error: 'Viewers cannot create invoice templates' };
  }

  if (!data.name?.trim()) {
    return { success: false, error: 'Template name is required' };
  }

  // If setting as default, unset any existing default
  if (data.isDefault) {
    await prisma.invoiceTemplate.updateMany({
      where: { workspaceId: workspace.id, isDefault: true },
      data: { isDefault: false },
    });
  }

  // Validate line items structure
  const lineItems = (data.lineItems ?? []).map((item) => ({
    id: String(item.id || ''),
    name: String(item.name || ''),
    description: String(item.description || ''),
    rate: Number.isFinite(item.rate) ? item.rate : 0,
    qty: Number.isFinite(item.qty) ? item.qty : 1,
    taxable: Boolean(item.taxable),
  }));

  const template = await prisma.invoiceTemplate.create({
    data: {
      workspaceId: workspace.id,
      name: data.name.trim(),
      description: data.description?.trim() || null,
      paymentTerms: data.paymentTerms || 'net30',
      currency: data.currency || 'USD',
      lineItems: lineItems as Prisma.InputJsonValue,
      notes: data.notes?.trim() || null,
      terms: data.terms?.trim() || null,
      isDefault: data.isDefault ?? false,
    },
  });

  revalidatePath('/templates/invoices');
  return { success: true, id: template.id };
}

export async function updateInvoiceTemplate(data: {
  id: string;
  name: string;
  description?: string;
  paymentTerms: string;
  currency: string;
  lineItems?: InvoiceTemplateLineItem[];
  notes?: string;
  terms?: string;
  isDefault: boolean;
}) {
  const { workspace } = await getActiveWorkspace();
  const { role } = await getCurrentUserWorkspace();
  if (role === 'viewer') {
    return { success: false, error: 'Viewers cannot update invoice templates' };
  }

  const template = await prisma.invoiceTemplate.findFirst({
    where: { id: data.id, workspaceId: workspace.id, deletedAt: null },
  });

  if (!template) {
    return { success: false, error: 'Template not found' };
  }

  if (!data.name?.trim()) {
    return { success: false, error: 'Template name is required' };
  }

  // If setting as default, unset any existing default
  if (data.isDefault && !template.isDefault) {
    await prisma.invoiceTemplate.updateMany({
      where: { workspaceId: workspace.id, isDefault: true },
      data: { isDefault: false },
    });
  }

  await prisma.invoiceTemplate.update({
    where: { id: data.id },
    data: {
      name: data.name.trim(),
      description: data.description?.trim() || null,
      paymentTerms: data.paymentTerms,
      currency: data.currency,
      lineItems: (data.lineItems ?? template.lineItems) as Prisma.InputJsonValue,
      notes: data.notes?.trim() ?? template.notes,
      terms: data.terms?.trim() ?? template.terms,
      isDefault: data.isDefault,
    },
  });

  revalidatePath('/templates/invoices');
  return { success: true };
}

export async function deleteInvoiceTemplate(id: string) {
  const { workspace } = await getActiveWorkspace();
  const { role } = await getCurrentUserWorkspace();
  if (role === 'viewer') {
    return { success: false, error: 'Viewers cannot delete invoice templates' };
  }

  const template = await prisma.invoiceTemplate.findFirst({
    where: { id, workspaceId: workspace.id, deletedAt: null },
  });

  if (!template) {
    return { success: false, error: 'Template not found' };
  }

  await prisma.invoiceTemplate.update({
    where: { id },
    data: { deletedAt: new Date() },
  });

  revalidatePath('/templates/invoices');
  return { success: true };
}

export async function duplicateInvoiceTemplate(id: string) {
  const { workspace } = await getActiveWorkspace();
  const { role } = await getCurrentUserWorkspace();
  if (role === 'viewer') {
    return { success: false, error: 'Viewers cannot duplicate invoice templates' };
  }

  const template = await prisma.invoiceTemplate.findFirst({
    where: { id, workspaceId: workspace.id, deletedAt: null },
  });

  if (!template) {
    return { success: false, error: 'Template not found' };
  }

  const duplicate = await prisma.invoiceTemplate.create({
    data: {
      workspaceId: workspace.id,
      name: `${template.name} (Copy)`,
      description: template.description,
      paymentTerms: template.paymentTerms,
      currency: template.currency,
      lineItems: (template.lineItems ?? []) as Prisma.InputJsonValue,
      notes: template.notes,
      terms: template.terms,
      isDefault: false,
    },
  });

  revalidatePath('/templates/invoices');
  return { success: true, id: duplicate.id };
}
