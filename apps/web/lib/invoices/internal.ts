/**
 * Internal invoice operations that should NOT be exposed as server actions.
 * This file intentionally does NOT have 'use server' directive.
 */

import { prisma, withTenantGuard } from '@wolff/database';
import {
  createInvoiceFromQuote,
  nextCreditNoteNumber,
  nextInvoiceNumber,
  type InvoiceFromQuoteResult,
} from '@wolff/core/invoices';

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
 * Used by the public portal when auto-invoice is enabled on quote acceptance.
 * The logic lives in `@wolff/core/invoices` and is shared with the API's
 * POST /v1/invoices/from-quote.
 *
 * NOT a server action - only callable from server-side code, not from the client.
 */
export async function createInvoiceFromQuoteInternal(
  quoteId: string,
  workspaceId: string,
  options?: { dueDays?: number }
): Promise<InvoiceFromQuoteResult> {
  return createInvoiceFromQuote(withTenantGuard(prisma), workspaceId, quoteId, options);
}
