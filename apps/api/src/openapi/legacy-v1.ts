import type { RouteConfig } from '@asteasolutions/zod-to-openapi';
import {
  errorEnvelopeSchema,
  legacyClientImportResultSchema,
  legacyClientImportSchema,
  legacyClientInputSchema,
  legacyClientListSchema,
  legacyClientSchema,
  legacyClientUpdateSchema,
  legacyCreatedClientSchema,
  legacyCreatedInvoiceSchema,
  legacyCreatedQuoteSchema,
  legacyDuplicatedQuoteSchema,
  legacyErrorSchema,
  legacyFromQuoteInputSchema,
  legacyInvoiceInputSchema,
  legacyInvoiceListSchema,
  legacyInvoiceSchema,
  legacyInvoiceSentSchema,
  legacyInvoiceUpdateSchema,
  legacyMessageSchema,
  legacyPageQuerySchema,
  legacyQuoteInputSchema,
  legacyQuoteListSchema,
  legacyQuoteSchema,
  legacyQuoteSentSchema,
  legacyQuoteUpdateSchema,
  legacySendInputSchema,
  z,
} from '@wolff/contracts';
import { registry } from './registry';

/**
 * OpenAPI for the routes ported from the Next app (Phase 6b). Their bodies
 * keep the pre-envelope shapes (`LegacyError` is `{ error }`); only what the
 * shared middleware answers (401, 403, 409 on Idempotency-Key, 429) uses
 * the standard `ErrorResponse`.
 */
type Schema = z.ZodType;
type Responses = RouteConfig['responses'];

const json = (schema: Schema, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

const legacy = (description: string) => json(legacyErrorSchema, description);

/** What every authenticated route can answer besides its own responses. */
const shared = (scopes: string): Responses => ({
  401: json(errorEnvelopeSchema, 'Missing, invalid, revoked or expired API key'),
  403: json(errorEnvelopeSchema, `API key lacks ${scopes}`),
  429: json(errorEnvelopeSchema, 'Rate limit exceeded; see Retry-After'),
});

const writeShared = (scopes: string): Responses => ({
  ...shared(scopes),
  409: json(
    errorEnvelopeSchema,
    'Idempotency-Key reused with another request, or its first request is still running'
  ),
});

const idParam = (name = 'id') => z.object({ [name]: z.string() });

const body = (schema: Schema, required = true) => ({
  body: { required, content: { 'application/json': { schema } } },
});

interface Operation {
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  tag: 'Clients' | 'Quotes' | 'Invoices';
  summary: string;
  description?: string;
  request?: RouteConfig['request'];
  responses: Responses;
}

function register(op: Operation) {
  return registry.registerPath({
    method: op.method,
    path: op.path,
    tags: [op.tag],
    summary: op.summary,
    description: op.description,
    request: op.request,
    responses: op.responses,
  });
}

// ---- clients ----

register({
  method: 'get',
  path: '/v1/clients',
  tag: 'Clients',
  summary: 'List clients',
  description:
    'Newest first. `search` matches name, email or company (case-insensitive). Deleted clients are not listed.',
  request: { query: legacyPageQuerySchema },
  responses: {
    200: json(legacyClientListSchema, 'A page of clients'),
    ...shared('`clients:read`'),
  },
});

register({
  method: 'post',
  path: '/v1/clients',
  tag: 'Clients',
  summary: 'Create a client',
  request: body(legacyClientInputSchema),
  responses: {
    201: json(legacyCreatedClientSchema, 'Client created'),
    400: legacy('Missing name or email, invalid email, metadata over 10 KB, or invalid JSON'),
    ...writeShared('`clients:write`'),
    409: json(
      z.union([legacyErrorSchema, errorEnvelopeSchema]),
      'A client with this email already exists (`{ error }`), or an Idempotency-Key conflict (envelope)'
    ),
  },
});

register({
  method: 'post',
  path: '/v1/clients/import',
  tag: 'Clients',
  summary: 'Import clients',
  description:
    'Creates up to 500 clients in one transaction. Rows with an invalid name or email fail; rows whose email exists (or repeats in the batch) are skipped.',
  request: body(legacyClientImportSchema),
  responses: {
    201: json(legacyClientImportResultSchema, 'Import result, row by row'),
    400: legacy('No rows, more than 500 rows, or invalid JSON'),
    ...writeShared('`clients:write`'),
  },
});

register({
  method: 'get',
  path: '/v1/clients/{id}',
  tag: 'Clients',
  summary: 'Get a client',
  request: { params: idParam() },
  responses: {
    200: json(legacyClientSchema, 'The client'),
    404: legacy('No such client in this workspace'),
    ...shared('`clients:read`'),
  },
});

register({
  method: 'patch',
  path: '/v1/clients/{id}',
  tag: 'Clients',
  summary: 'Update a client',
  request: { params: idParam(), ...body(legacyClientUpdateSchema) },
  responses: {
    200: json(legacyClientSchema, 'The updated client'),
    400: legacy('Empty name, invalid email, metadata over 10 KB, or invalid JSON'),
    404: legacy('No such client in this workspace'),
    409: legacy('A client with this email already exists'),
    ...shared('`clients:write`'),
  },
});

register({
  method: 'delete',
  path: '/v1/clients/{id}',
  tag: 'Clients',
  summary: 'Delete a client',
  description: 'Soft delete: the client is hidden from every list and lookup.',
  request: { params: idParam() },
  responses: {
    200: json(legacyMessageSchema, 'Client deleted'),
    404: legacy('No such client in this workspace'),
    ...shared('`clients:write`'),
  },
});

// ---- quotes ----

register({
  method: 'get',
  path: '/v1/quotes',
  tag: 'Quotes',
  summary: 'List quotes',
  description: 'Newest first, with line items. `search` matches the title.',
  request: {
    query: legacyPageQuerySchema.extend({
      status: z
        .enum(['draft', 'sent', 'viewed', 'accepted', 'declined', 'expired', 'converted'])
        .optional(),
    }),
  },
  responses: {
    200: json(legacyQuoteListSchema, 'A page of quotes'),
    400: legacy('Unknown status'),
    ...shared('`quotes:read`'),
  },
});

register({
  method: 'post',
  path: '/v1/quotes',
  tag: 'Quotes',
  summary: 'Create a quote',
  description:
    'A draft, numbered from the workspace sequence. Currency defaults to the business profile’s.',
  request: body(legacyQuoteInputSchema),
  responses: {
    201: json(legacyCreatedQuoteSchema, 'Quote created'),
    400: legacy('Missing field, invalid currency or line item, or invalid JSON'),
    404: legacy('Client or project not found in this workspace'),
    ...writeShared('`quotes:write`'),
  },
});

register({
  method: 'get',
  path: '/v1/quotes/{id}',
  tag: 'Quotes',
  summary: 'Get a quote',
  request: { params: idParam() },
  responses: {
    200: json(legacyQuoteSchema, 'The quote'),
    404: legacy('No such quote in this workspace'),
    ...shared('`quotes:read`'),
  },
});

register({
  method: 'patch',
  path: '/v1/quotes/{id}',
  tag: 'Quotes',
  summary: 'Update a quote',
  description:
    'Replaces the line items when given and recomputes the totals. Status moves only along draft → sent → viewed → accepted/declined/expired (declined/expired → draft).',
  request: { params: idParam(), ...body(legacyQuoteUpdateSchema) },
  responses: {
    200: json(legacyQuoteSchema, 'The updated quote'),
    400: legacy('Invalid transition, invalid line item, accepted quote, or invalid JSON'),
    404: legacy('No such quote in this workspace'),
    ...shared('`quotes:write`'),
  },
});

register({
  method: 'delete',
  path: '/v1/quotes/{id}',
  tag: 'Quotes',
  summary: 'Delete a quote',
  request: { params: idParam() },
  responses: {
    200: json(legacyMessageSchema, 'Quote deleted'),
    404: legacy('No such quote in this workspace'),
    ...shared('`quotes:write`'),
  },
});

register({
  method: 'post',
  path: '/v1/quotes/{id}/duplicate',
  tag: 'Quotes',
  summary: 'Duplicate a quote',
  request: { params: idParam() },
  responses: {
    201: json(legacyDuplicatedQuoteSchema, 'The copy, as a new draft'),
    404: legacy('No such quote in this workspace'),
    ...writeShared('`quotes:write`'),
  },
});

register({
  method: 'post',
  path: '/v1/quotes/{id}/send',
  tag: 'Quotes',
  summary: 'Send a quote',
  description:
    'Emails the portal link to the client (or to `recipients`) and marks the quote sent. The body is optional.',
  request: { params: idParam(), ...body(legacySendInputSchema, false) },
  responses: {
    ...writeShared('`quotes:write`'),
    200: json(legacyQuoteSentSchema, 'Email sent'),
    400: legacy('Status does not allow sending, no recipient, invalid recipients, or zero total'),
    404: legacy('No such quote in this workspace'),
    502: legacy('The email could not be sent; the quote is unchanged'),
    429: json(
      z.union([legacyErrorSchema, errorEnvelopeSchema]),
      'Per-key rate limit (envelope), or the workspace sent 20 emails this hour (`{ error }`, Retry-After)'
    ),
  },
});

// ---- invoices ----

register({
  method: 'get',
  path: '/v1/invoices',
  tag: 'Invoices',
  summary: 'List invoices',
  description: 'Newest first, with line items. `search` matches the title.',
  request: {
    query: legacyPageQuerySchema.extend({
      status: z
        .enum(['draft', 'sent', 'viewed', 'partial', 'paid', 'overdue', 'voided'])
        .optional(),
      clientId: z.string().optional(),
    }),
  },
  responses: {
    200: json(legacyInvoiceListSchema, 'A page of invoices'),
    400: legacy('Unknown status'),
    ...shared('`invoices:read`'),
  },
});

register({
  method: 'post',
  path: '/v1/invoices',
  tag: 'Invoices',
  summary: 'Create an invoice',
  description:
    'A draft. In a GST workspace the lines are priced by the GST engine and the number follows the financial year.',
  request: body(legacyInvoiceInputSchema),
  responses: {
    201: json(legacyCreatedInvoiceSchema, 'Invoice created'),
    400: legacy('Missing field, invalid date, currency or line item, or invalid JSON'),
    404: legacy('Client or project not found in this workspace'),
    422: legacy('GST pricing refused the lines'),
    ...writeShared('`invoices:write`'),
  },
});

register({
  method: 'post',
  path: '/v1/invoices/from-quote/{quoteId}',
  tag: 'Invoices',
  summary: 'Create an invoice from a quote',
  description:
    'Copies the quote’s lines and marks the quote converted. The invoice is issued at once, except in a GST workspace whose Rule 46 details are incomplete (it stays a draft).',
  request: { params: idParam('quoteId'), ...body(legacyFromQuoteInputSchema, false) },
  responses: {
    201: json(legacyInvoiceSchema, 'Invoice created'),
    400: legacy('The quote already has an invoice, invalid dueDays, or GST pricing refused it'),
    404: legacy('No such quote in this workspace'),
    ...writeShared('`invoices:write` and `quotes:write`'),
  },
});

register({
  method: 'get',
  path: '/v1/invoices/{id}',
  tag: 'Invoices',
  summary: 'Get an invoice',
  request: { params: idParam() },
  responses: {
    200: json(legacyInvoiceSchema, 'The invoice'),
    404: legacy('No such invoice in this workspace'),
    ...shared('`invoices:read`'),
  },
});

register({
  method: 'patch',
  path: '/v1/invoices/{id}',
  tag: 'Invoices',
  summary: 'Update an invoice',
  description:
    'Paid and voided invoices only change status. Leaving draft checks Rule 46 in a GST workspace; an issued GST invoice is corrected with a credit note, not edited.',
  request: { params: idParam(), ...body(legacyInvoiceUpdateSchema) },
  responses: {
    200: json(legacyInvoiceSchema, 'The updated invoice'),
    400: legacy('Invalid transition, date or line item, locked invoice, or invalid JSON'),
    404: legacy('No such invoice in this workspace'),
    422: legacy('GST: Rule 46 details missing, or an issued GST invoice'),
    ...shared('`invoices:write`'),
  },
});

register({
  method: 'delete',
  path: '/v1/invoices/{id}',
  tag: 'Invoices',
  summary: 'Delete an invoice',
  request: { params: idParam() },
  responses: {
    200: json(legacyMessageSchema, 'Invoice deleted'),
    400: legacy('Paid or partially paid invoices are voided, not deleted'),
    404: legacy('No such invoice in this workspace'),
    ...shared('`invoices:write`'),
  },
});

register({
  method: 'post',
  path: '/v1/invoices/{id}/send',
  tag: 'Invoices',
  summary: 'Send an invoice',
  description:
    'Emails the payment link to the client (or to `recipients`) and marks the invoice sent. The body is optional.',
  request: { params: idParam(), ...body(legacySendInputSchema, false) },
  responses: {
    ...writeShared('`invoices:write`'),
    200: json(legacyInvoiceSentSchema, 'Email sent'),
    400: legacy('Status does not allow sending, no recipient, invalid recipients, or zero total'),
    404: legacy('No such invoice in this workspace'),
    422: legacy('GST: Rule 46 details missing'),
    502: legacy('The email could not be sent; the invoice is unchanged'),
    429: json(
      z.union([legacyErrorSchema, errorEnvelopeSchema]),
      'Per-key rate limit (envelope), or the workspace sent 20 emails this hour (`{ error }`, Retry-After)'
    ),
  },
});
