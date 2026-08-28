import { toNumber } from './http';

/**
 * The quote and invoice shapes the Next `/api/v1` routes returned, field for
 * field and in the same order (the parity test compares bytes).
 */
type Decimalish = { toNumber(): number } | number | string | null | undefined;

interface DocumentClient {
  id: string;
  name: string;
  email: string;
  company: string | null;
}

export interface LineItemRow {
  id: string;
  name: string;
  description: string | null;
  quantity: Decimalish;
  rate: Decimalish;
  amount: Decimalish;
  taxRate: Decimalish;
  taxAmount: Decimalish;
}

/** A truthy rate as a number, else null: `li.taxRate ? toNumber(li.taxRate) : null`. */
const nullableNumber = (value: Decimalish) => (value ? toNumber(value) : null);

export function formatLineItem(li: LineItemRow) {
  return {
    id: li.id,
    name: li.name,
    description: li.description,
    quantity: toNumber(li.quantity),
    rate: toNumber(li.rate),
    amount: toNumber(li.amount),
    taxRate: nullableNumber(li.taxRate),
    taxAmount: toNumber(li.taxAmount),
  };
}

/** The line items of a create response: no tax columns. */
export function formatShortLineItem(li: LineItemRow) {
  return {
    id: li.id,
    name: li.name,
    description: li.description,
    quantity: toNumber(li.quantity),
    rate: toNumber(li.rate),
    amount: toNumber(li.amount),
  };
}

export interface QuoteRow {
  id: string;
  quoteNumber: string;
  title: string | null;
  status: string;
  client: DocumentClient | null;
  currency: string;
  subtotal: Decimalish;
  discountType: string | null;
  discountValue: Decimalish;
  discountAmount: Decimalish;
  taxTotal: Decimalish;
  total: Decimalish;
  notes: string | null;
  terms: string | null;
  issueDate: Date;
  expirationDate: Date | null;
  sentAt: Date | null;
  acceptedAt: Date | null;
  declinedAt: Date | null;
  lineItems: LineItemRow[];
  createdAt: Date;
  updatedAt: Date;
}

export function formatQuote(q: QuoteRow) {
  return {
    id: q.id,
    quoteNumber: q.quoteNumber,
    title: q.title,
    status: q.status,
    client: q.client,
    currency: q.currency,
    subtotal: toNumber(q.subtotal),
    discountType: q.discountType,
    discountValue: nullableNumber(q.discountValue),
    discountAmount: toNumber(q.discountAmount),
    taxTotal: toNumber(q.taxTotal),
    total: toNumber(q.total),
    notes: q.notes,
    terms: q.terms,
    issueDate: q.issueDate,
    expirationDate: q.expirationDate,
    sentAt: q.sentAt,
    acceptedAt: q.acceptedAt,
    declinedAt: q.declinedAt,
    lineItems: q.lineItems.map(formatLineItem),
    createdAt: q.createdAt,
    updatedAt: q.updatedAt,
  };
}

export interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  title: string | null;
  status: string;
  client: DocumentClient | null;
  currency: string;
  issueDate: Date;
  dueDate: Date;
  subtotal: Decimalish;
  discountType: string | null;
  discountValue: Decimalish;
  discountAmount: Decimalish;
  taxTotal: Decimalish;
  total: Decimalish;
  amountPaid: Decimalish;
  amountDue: Decimalish;
  notes: string | null;
  terms: string | null;
  sentAt: Date | null;
  paidAt: Date | null;
  voidedAt: Date | null;
  lineItems: LineItemRow[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * `voidedAt` was returned by GET and PATCH `/invoices/:id` only, not by the
 * list or from-quote routes.
 */
export function formatInvoice(inv: InvoiceRow, options: { voidedAt?: boolean } = {}) {
  return {
    id: inv.id,
    invoiceNumber: inv.invoiceNumber,
    title: inv.title,
    status: inv.status,
    client: inv.client,
    currency: inv.currency,
    issueDate: inv.issueDate,
    dueDate: inv.dueDate,
    subtotal: toNumber(inv.subtotal),
    discountType: inv.discountType,
    discountValue: nullableNumber(inv.discountValue),
    discountAmount: toNumber(inv.discountAmount),
    taxTotal: toNumber(inv.taxTotal),
    total: toNumber(inv.total),
    amountPaid: toNumber(inv.amountPaid),
    amountDue: toNumber(inv.amountDue),
    notes: inv.notes,
    terms: inv.terms,
    sentAt: inv.sentAt,
    paidAt: inv.paidAt,
    ...(options.voidedAt ? { voidedAt: inv.voidedAt } : {}),
    lineItems: inv.lineItems.map(formatLineItem),
    createdAt: inv.createdAt,
    updatedAt: inv.updatedAt,
  };
}

/** The `client` relation every document response includes. */
export const DOCUMENT_INCLUDE = {
  client: { select: { id: true, name: true, email: true, company: true } },
  lineItems: { orderBy: { sortOrder: 'asc' as const } },
};
