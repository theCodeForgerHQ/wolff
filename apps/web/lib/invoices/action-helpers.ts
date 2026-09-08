/**
 * Helpers shared by the invoice server actions. Not a 'use server' module:
 * nothing here may be called from the browser.
 */
import { randomBytes } from 'crypto';
import { prisma, withTenantGuard } from '@wolff/database';
import { assertReadyToIssue, describeCoreError } from '@wolff/core/invoices';
import { CoreError } from '@wolff/core/errors';
import { applyDiscount } from '@wolff/core/pricing';
import { getCurrentUserWorkspace } from '@/lib/workspace/get-current-workspace';

export const gstDb = withTenantGuard(prisma);

/** A Rule 46 / GST refusal as the message the dashboard shows. */
export { describeCoreError };

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

  // The discount comes off before tax (shared with the API).
  const priced = applyDiscount({ subtotal, taxTotal }, discount?.type, discount?.value);
  return { subtotal, ...priced };
}
