'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@wolff/database';
import { getCurrentUserWorkspace } from '@/lib/workspace/get-current-workspace';
import { ROUTES } from '@/lib/routes';

export interface RecurringSettingsInput {
  enabled: boolean;
  frequency: string; // weekly, biweekly, monthly, quarterly, yearly
  startDate: string; // ISO date string
  endDate: string | null; // ISO date string or null
  autoSend: boolean;
}

const VALID_INTERVALS = ['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'];

/**
 * Calculate the next recurring date from a given date and interval.
 */
function calculateNextDate(fromDate: Date, interval: string): Date {
  const next = new Date(fromDate);
  switch (interval) {
    case 'weekly':
      next.setDate(next.getDate() + 7);
      break;
    case 'biweekly':
      next.setDate(next.getDate() + 14);
      break;
    case 'monthly':
      next.setMonth(next.getMonth() + 1);
      break;
    case 'quarterly':
      next.setMonth(next.getMonth() + 3);
      break;
    case 'yearly':
      next.setFullYear(next.getFullYear() + 1);
      break;
    default:
      next.setMonth(next.getMonth() + 1);
  }
  return next;
}

/**
 * Update recurring settings for an invoice.
 * Saves the recurring configuration to the invoice record in the database.
 */
export async function updateRecurringSettings(
  invoiceId: string,
  settings: RecurringSettingsInput
): Promise<{ success: boolean; error?: string }> {
  const { workspaceId, role } = await getCurrentUserWorkspace();

  if (role === 'viewer') {
    return { success: false, error: 'Insufficient permissions' };
  }

  if (!invoiceId || typeof invoiceId !== 'string') {
    return { success: false, error: 'Invoice ID is required' };
  }

  // Validate interval
  if (settings.enabled && !VALID_INTERVALS.includes(settings.frequency)) {
    return {
      success: false,
      error: `Invalid frequency. Must be one of: ${VALID_INTERVALS.join(', ')}`,
    };
  }

  // Find the invoice and verify ownership
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, workspaceId, deletedAt: null },
  });

  if (!invoice) {
    return { success: false, error: 'Invoice not found' };
  }

  // Calculate next recurring date
  let nextRecurringDate: Date | null = null;
  if (settings.enabled) {
    const startDate = new Date(settings.startDate);
    const now = new Date();
    // If start date is in the future, use it. Otherwise calculate the next one from now.
    if (startDate > now) {
      nextRecurringDate = startDate;
    } else {
      nextRecurringDate = calculateNextDate(now, settings.frequency);
    }

    // If there's an end date and nextRecurringDate exceeds it, don't set it
    if (settings.endDate) {
      const endDate = new Date(settings.endDate);
      if (nextRecurringDate > endDate) {
        nextRecurringDate = null;
      }
    }
  }

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      isRecurring: settings.enabled,
      recurringInterval: settings.enabled ? settings.frequency : null,
      recurringStartDate: settings.enabled ? new Date(settings.startDate) : null,
      recurringEndDate: settings.enabled && settings.endDate ? new Date(settings.endDate) : null,
      recurringAutoSend: settings.enabled ? settings.autoSend : false,
      nextRecurringDate,
    },
  });

  revalidatePath(ROUTES.invoices);
  revalidatePath(`/invoices/${invoiceId}`);

  return { success: true };
}

/**
 * Get recurring settings for an invoice.
 */
export async function getRecurringSettings(invoiceId: string): Promise<{
  enabled: boolean;
  frequency: string;
  startDate: string;
  endDate: string | null;
  noEndDate: boolean;
  autoSend: boolean;
  nextRecurringDate: string | null;
} | null> {
  const { workspaceId } = await getCurrentUserWorkspace();

  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, workspaceId, deletedAt: null },
    select: {
      isRecurring: true,
      recurringInterval: true,
      recurringStartDate: true,
      recurringEndDate: true,
      recurringAutoSend: true,
      nextRecurringDate: true,
    },
  });

  if (!invoice) {
    return null;
  }

  return {
    enabled: invoice.isRecurring,
    frequency: invoice.recurringInterval || 'monthly',
    startDate: invoice.recurringStartDate?.toISOString() || new Date().toISOString(),
    endDate: invoice.recurringEndDate?.toISOString() || null,
    noEndDate: !invoice.recurringEndDate,
    autoSend: invoice.recurringAutoSend,
    nextRecurringDate: invoice.nextRecurringDate?.toISOString() || null,
  };
}

/**
 * Get IDs of all recurring invoices in a workspace.
 * Used by the invoice list to show recurring badges.
 */
export async function getRecurringInvoiceIds(): Promise<string[]> {
  // The workspace comes from the session only: this is a server action, so
  // any argument it took would be chosen by the browser.
  let workspaceId: string;
  try {
    ({ workspaceId } = await getCurrentUserWorkspace());
  } catch {
    return [];
  }
  const invoices = await prisma.invoice.findMany({
    where: {
      workspaceId,
      isRecurring: true,
      deletedAt: null,
    },
    select: { id: true },
  });
  return invoices.map((i) => i.id);
}
