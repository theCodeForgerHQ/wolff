/**
 * Helpers shared by the invoice server actions. Not a 'use server' module:
 * nothing here may be called from the browser.
 */
import { randomBytes } from 'crypto';
import { prisma, withTenantGuard } from '@wolff/database';
import { assertReadyToIssue } from '@wolff/core/invoices';
import { CoreError } from '@wolff/core/errors';
import { getCurrentUserWorkspace } from '@/lib/workspace/get-current-workspace';

export const gstDb = withTenantGuard(prisma);

/** A Rule 46 / GST refusal as the message the dashboard shows. */
export function describeCoreError(error: CoreError): string {
  const reasons = error.details ? Object.values(error.details).flat() : [];
  return reasons.length > 0 ? `${error.message}: ${reasons.join('; ')}` : error.message;
}

/** Throws nothing; returns the reason a draft may not be issued, if any. */
export async function issueBlocker(workspaceId: string, invoiceId: string): Promise<string | null> {
  try {
    await assertReadyToIssue(gstDb, workspaceId, invoiceId);
    return null;
  } catch (error) {
    if (error instanceof CoreError) return describeCoreError(error);
    throw error;
  }
}

/** Generate a cryptographically secure access token (64 hex chars = 256 bits) */
export function generateAccessToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Get the current user's active workspace with full workspace data
 */
export async function getActiveWorkspace() {
  const { workspaceId, userId } = await getCurrentUserWorkspace();

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
  });

  if (!workspace) {
    throw new Error('Workspace not found');
  }

  return {
    userId,
    workspace,
  };
}

/**
 * Calculate totals from line items, applying discount before tax total
 */
export function calculateTotals(
  lineItems: Array<{ quantity: number; rate: number; taxRate?: number }>,
  discount?: { type?: 'percentage' | 'fixed' | null; value?: number | null }
) {
  let subtotal = 0;
  let taxTotal = 0;

  for (const item of lineItems) {
    const amount = item.quantity * item.rate;
    subtotal += amount;
    if (item.taxRate) {
      taxTotal += amount * (item.taxRate / 100);
    }
  }

  subtotal = Math.round(subtotal * 100) / 100;
  taxTotal = Math.round(taxTotal * 100) / 100;

  // Calculate discount amount
  let discountAmount = 0;
  if (discount?.type && discount.value != null && discount.value > 0) {
    if (discount.type === 'percentage') {
      discountAmount = subtotal * (discount.value / 100);
    } else if (discount.type === 'fixed') {
      discountAmount = discount.value;
    }
  }

  // Clamp: discount cannot exceed subtotal (prevents negative total before tax)
  discountAmount = Math.min(discountAmount, subtotal);
  discountAmount = Math.round(discountAmount * 100) / 100;

  // Tax should apply to the discounted amount, not the full subtotal.
  // Proportionally reduce tax by the same ratio as the discount.
  if (subtotal > 0 && discountAmount > 0) {
    taxTotal = Math.round(taxTotal * ((subtotal - discountAmount) / subtotal) * 100) / 100;
  }

  return {
    subtotal,
    taxTotal,
    discountAmount,
    total: Math.round((subtotal - discountAmount + taxTotal) * 100) / 100,
  };
}
