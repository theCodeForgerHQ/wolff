import { z } from './zod';

/**
 * The contract of the `/v1/clients`, `/v1/quotes` and `/v1/invoices` routes
 * ported from the Next app. These routes predate the
 * `{ success, data }` envelope and keep their original shapes: a resource is
 * returned bare, a list as `{ data, pagination }`, an error as
 * `{ error: "<message>" }`. The schemas describe responses for the OpenAPI
 * document; the routes validate requests field by field, as before, so the
 * request schemas list what is read rather than reject unknown fields.
 */
const timestamp = z.iso.datetime();
const json = z.unknown().openapi({ description: 'Any JSON value' });
const money = z.number();

export const legacyErrorSchema = z
  .object({ error: z.string().openapi({ example: 'Client not found' }) })
  .openapi('LegacyError');

export const legacyMessageSchema = z
  .object({ message: z.string().openapi({ example: 'Client deleted' }) })
  .openapi('LegacyMessage');

export const legacyPaginationSchema = z
  .object({
    page: z.number().int(),
    limit: z.number().int(),
    total: z.number().int(),
    totalPages: z.number().int(),
  })
  .openapi('LegacyPagination');

export const legacyPageQuerySchema = z.object({
  page: z.string().optional().openapi({ description: 'Page number, from 1', example: '1' }),
  limit: z
    .string()
    .optional()
    .openapi({ description: 'Items per page, 1 to 100 (default 25)', example: '25' }),
  search: z.string().optional(),
});

const legacyList = <T extends z.ZodType>(item: T, name: string) =>
  z.object({ data: z.array(item), pagination: legacyPaginationSchema }).openapi(name);

// ---- clients ----

export const legacyClientSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    phone: z.string().nullable(),
    company: z.string().nullable(),
    address: json,
    billingAddress: json,
    metadata: json,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .openapi('LegacyClient');

export const legacyCreatedClientSchema = legacyClientSchema
  .omit({ updatedAt: true })
  .openapi('LegacyCreatedClient');

export const legacyClientListSchema = legacyList(legacyClientSchema, 'LegacyClientList');

export const legacyClientInputSchema = z
  .object({
    name: z.string().openapi({ example: 'Chola Foods' }),
    email: z.string().openapi({ example: 'accounts@chola.example' }),
    phone: z.string().nullable().optional(),
    company: z.string().nullable().optional(),
    address: z.record(z.string(), z.string()).optional(),
    billingAddress: z.record(z.string(), z.string()).optional(),
    metadata: z
      .record(z.string(), z.unknown())
      .optional()
      .openapi({ description: 'At most 10 KB' }),
  })
  .openapi('LegacyClientInput');

export const legacyClientUpdateSchema = legacyClientInputSchema
  .partial()
  .openapi('LegacyClientUpdate');

export const legacyClientImportSchema = z
  .object({
    clients: z
      .array(
        z.object({
          name: z.string(),
          email: z.string(),
          phone: z.string().optional(),
          company: z.string().optional(),
          street: z.string().optional(),
          city: z.string().optional(),
          state: z.string().optional(),
          postalCode: z.string().optional(),
          country: z.string().optional(),
        })
      )
      .openapi({ description: '1 to 500 rows' }),
    skipDuplicates: z.boolean().optional().openapi({ description: 'Default true' }),
  })
  .openapi('LegacyClientImport');

export const legacyClientImportResultSchema = z
  .object({
    message: z.string(),
    success: z.number().int(),
    failed: z.number().int(),
    skipped: z.number().int(),
    errors: z.array(z.object({ row: z.number().int(), message: z.string() })),
    created: z.array(z.object({ id: z.string(), name: z.string(), email: z.string() })),
  })
  .openapi('LegacyClientImportResult');

// ---- quotes and invoices ----

const documentClientSchema = z
  .object({ id: z.string(), name: z.string(), email: z.string(), company: z.string().nullable() })
  .nullable()
  .openapi('LegacyDocumentClient');

export const legacyLineItemSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    quantity: money,
    rate: money,
    amount: money,
    taxRate: money.nullable(),
    taxAmount: money,
  })
  .openapi('LegacyLineItem');

const shortLineItemSchema = legacyLineItemSchema
  .omit({ taxRate: true, taxAmount: true })
  .openapi('LegacyLineItemSummary');

export const legacyLineItemInputSchema = z
  .object({
    name: z.string().openapi({ example: 'Workshop' }),
    description: z.string().optional(),
    quantity: z.number().openapi({ description: '0 to 1,000,000', example: 2 }),
    rate: z.number().openapi({ description: '0 to 1,000,000', example: 1500 }),
    taxRate: z.number().optional().openapi({ description: 'Percent, 0 to 100', example: 18 }),
  })
  .openapi('LegacyLineItemInput');

const discountFields = {
  discountType: z.string().nullable(),
  discountValue: money.nullable(),
  discountAmount: money,
};

export const legacyQuoteSchema = z
  .object({
    id: z.string(),
    quoteNumber: z.string(),
    title: z.string().nullable(),
    status: z.string(),
    client: documentClientSchema,
    currency: z.string(),
    subtotal: money,
    ...discountFields,
    taxTotal: money,
    total: money,
    notes: z.string().nullable(),
    terms: z.string().nullable(),
    issueDate: timestamp,
    expirationDate: timestamp.nullable(),
    sentAt: timestamp.nullable(),
    acceptedAt: timestamp.nullable(),
    declinedAt: timestamp.nullable(),
    lineItems: z.array(legacyLineItemSchema),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .openapi('LegacyQuote');

export const legacyQuoteListSchema = legacyList(legacyQuoteSchema, 'LegacyQuoteList');

export const legacyCreatedQuoteSchema = z
  .object({
    id: z.string(),
    quoteNumber: z.string(),
    title: z.string().nullable(),
    status: z.string(),
    client: documentClientSchema,
    currency: z.string(),
    subtotal: money,
    taxTotal: money,
    total: money,
    lineItems: z.array(shortLineItemSchema),
    createdAt: timestamp,
  })
  .openapi('LegacyCreatedQuote');

export const legacyDuplicatedQuoteSchema = legacyQuoteSchema
  .omit({
    notes: true,
    terms: true,
    issueDate: true,
    expirationDate: true,
    sentAt: true,
    acceptedAt: true,
    declinedAt: true,
    updatedAt: true,
  })
  .openapi('LegacyDuplicatedQuote');

export const legacyQuoteInputSchema = z
  .object({
    title: z.string().openapi({ example: 'Website redesign' }),
    clientId: z.string(),
    projectId: z.string().optional(),
    currency: z.string().optional().openapi({ description: 'ISO 4217 code', example: 'INR' }),
    lineItems: z
      .array(legacyLineItemInputSchema)
      .optional()
      .openapi({ description: 'At most 100' }),
  })
  .openapi('LegacyQuoteInput');

export const legacyQuoteUpdateSchema = z
  .object({
    title: z.string().optional(),
    notes: z.string().optional(),
    terms: z.string().optional(),
    status: z.string().optional(),
    lineItems: z.array(legacyLineItemInputSchema).optional(),
  })
  .openapi('LegacyQuoteUpdate');

export const legacySendInputSchema = z
  .object({
    message: z.string().optional(),
    recipients: z.array(z.string()).optional().openapi({ description: 'At most 10 addresses' }),
  })
  .openapi('LegacySendInput');

export const legacyQuoteSentSchema = z
  .object({ message: z.string(), emailSent: z.boolean(), quoteUrl: z.string() })
  .openapi('LegacyQuoteSent');

export const legacyInvoiceSchema = z
  .object({
    id: z.string(),
    invoiceNumber: z.string(),
    title: z.string().nullable(),
    status: z.string(),
    client: documentClientSchema,
    currency: z.string(),
    issueDate: timestamp,
    dueDate: timestamp,
    subtotal: money,
    ...discountFields,
    taxTotal: money,
    total: money,
    amountPaid: money,
    amountDue: money,
    notes: z.string().nullable(),
    terms: z.string().nullable(),
    sentAt: timestamp.nullable(),
    paidAt: timestamp.nullable(),
    voidedAt: timestamp
      .nullable()
      .optional()
      .openapi({ description: 'Returned by GET and PATCH /invoices/{id}' }),
    lineItems: z.array(legacyLineItemSchema),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .openapi('LegacyInvoice');

export const legacyInvoiceListSchema = legacyList(legacyInvoiceSchema, 'LegacyInvoiceList');

export const legacyCreatedInvoiceSchema = z
  .object({
    id: z.string(),
    invoiceNumber: z.string(),
    title: z.string().nullable(),
    status: z.string(),
    client: documentClientSchema,
    currency: z.string(),
    dueDate: timestamp,
    subtotal: money,
    taxTotal: money,
    total: money,
    amountPaid: money,
    amountDue: money,
    lineItems: z.array(shortLineItemSchema),
    createdAt: timestamp,
  })
  .openapi('LegacyCreatedInvoice');

const invoiceLineInputSchema = legacyLineItemInputSchema
  .extend({
    hsnSac: z.string().optional().openapi({ description: 'GST workspaces' }),
    itemType: z.enum(['goods', 'services']).optional(),
  })
  .openapi('LegacyInvoiceLineItemInput');

export const legacyInvoiceInputSchema = z
  .object({
    title: z.string().openapi({ example: 'October retainer' }),
    clientId: z.string(),
    projectId: z.string().optional(),
    currency: z.string().optional(),
    dueDate: z.string().openapi({ example: '2026-12-31' }),
    notes: z.string().optional(),
    terms: z.string().optional(),
    lineItems: z.array(invoiceLineInputSchema).optional(),
  })
  .openapi('LegacyInvoiceInput');

export const legacyInvoiceUpdateSchema = z
  .object({
    title: z.string().optional(),
    notes: z.string().optional(),
    terms: z.string().optional(),
    dueDate: z.string().optional(),
    status: z.string().optional(),
    lineItems: z.array(invoiceLineInputSchema).optional(),
  })
  .openapi('LegacyInvoiceUpdate');

export const legacyInvoiceSentSchema = z
  .object({ message: z.string(), emailSent: z.boolean(), invoiceUrl: z.string() })
  .openapi('LegacyInvoiceSent');

export const legacyFromQuoteInputSchema = z
  .object({ dueDays: z.number().optional().openapi({ description: '0 to 365, default 30' }) })
  .openapi('LegacyFromQuoteInput');
