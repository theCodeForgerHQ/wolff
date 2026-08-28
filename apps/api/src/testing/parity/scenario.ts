import { PARITY } from './seed';

/**
 * The requests the parity suite replays, in order, on the Next routes
 * (`/api/v1`, to record) and on the Express routes (`/v1`, to compare).
 * Later steps use ids that earlier steps created; `capture` stores them.
 * Every route file and method of the design's table is covered, with its
 * success path, its validation and not-found answers, and the pagination
 * of the three list endpoints.
 */
export type RouteGroup = 'clients' | 'quotes' | 'invoices';

export interface ParityContext {
  created: Record<string, string>;
}

export interface ParityStep {
  name: string;
  group: RouteGroup;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string | ((ctx: ParityContext) => string);
  /** JSON body. */
  body?: unknown;
  /** Sent as-is with a JSON content type (malformed bodies). */
  rawBody?: string;
  /** Which credential to send. Default: the main workspace's key. */
  auth?: 'main' | 'gst' | 'none' | 'invalid';
  /**
   * 401s are compared on status and the presence of `error` only: the new
   * API answers them with the standard envelope (a documented change).
   */
  authFailure?: boolean;
  /** Stores an id from the response body for later steps. */
  capture?: string;
}

const { clients, quotes, invoices } = PARITY;
const line = { name: 'Workshop', description: 'One day', quantity: 2, rate: 1500, taxRate: 18 };

export const PARITY_SCENARIO: ParityStep[] = [
  // ---- auth (one route per file is enough; the middleware is shared) ----
  {
    name: 'clients list without a key',
    group: 'clients',
    method: 'GET',
    path: '/clients',
    auth: 'none',
    authFailure: true,
  },
  {
    name: 'clients list with an unknown key',
    group: 'clients',
    method: 'GET',
    path: '/clients',
    auth: 'invalid',
    authFailure: true,
  },
  {
    name: 'quotes list without a key',
    group: 'quotes',
    method: 'GET',
    path: '/quotes',
    auth: 'none',
    authFailure: true,
  },
  {
    name: 'invoices list without a key',
    group: 'invoices',
    method: 'GET',
    path: '/invoices',
    auth: 'none',
    authFailure: true,
  },

  // ---- /clients ----
  { name: 'clients list', group: 'clients', method: 'GET', path: '/clients' },
  {
    name: 'clients list page 2 of 1',
    group: 'clients',
    method: 'GET',
    path: '/clients?page=2&limit=1',
  },
  {
    name: 'clients list clamps page and limit',
    group: 'clients',
    method: 'GET',
    path: '/clients?page=-4&limit=500',
  },
  { name: 'clients list search', group: 'clients', method: 'GET', path: '/clients?search=ACME' },
  {
    name: 'clients create',
    group: 'clients',
    method: 'POST',
    path: '/clients',
    capture: 'client',
    body: {
      name: 'Chola Foods',
      email: 'chola@parity.test',
      phone: '+91 44 0000',
      company: 'Chola',
      address: { city: 'Chennai' },
      metadata: { source: 'api' },
      workspaceId: PARITY.otherWorkspace,
      id: 'forged',
    },
  },
  {
    name: 'clients create without name',
    group: 'clients',
    method: 'POST',
    path: '/clients',
    body: { email: 'x@parity.test' },
  },
  {
    name: 'clients create without email',
    group: 'clients',
    method: 'POST',
    path: '/clients',
    body: { name: 'X' },
  },
  {
    name: 'clients create with a bad email',
    group: 'clients',
    method: 'POST',
    path: '/clients',
    body: { name: 'X', email: 'nope' },
  },
  {
    name: 'clients create with a duplicate email',
    group: 'clients',
    method: 'POST',
    path: '/clients',
    body: { name: 'Again', email: 'acme@parity.test' },
  },
  {
    name: 'clients create with metadata over 10 KB',
    group: 'clients',
    method: 'POST',
    path: '/clients',
    body: { name: 'Big', email: 'big@parity.test', metadata: { blob: 'x'.repeat(10_001) } },
  },
  {
    name: 'clients create with malformed JSON',
    group: 'clients',
    method: 'POST',
    path: '/clients',
    rawBody: '{"name":',
  },
  { name: 'clients get', group: 'clients', method: 'GET', path: `/clients/${clients.acme}` },
  {
    name: 'clients get a deleted client',
    group: 'clients',
    method: 'GET',
    path: `/clients/${clients.deleted}`,
  },
  {
    name: 'clients get another workspace’s client',
    group: 'clients',
    method: 'GET',
    path: `/clients/${clients.other}`,
  },
  {
    name: 'clients update',
    group: 'clients',
    method: 'PATCH',
    path: (c) => `/clients/${c.created.client}`,
    body: { name: 'Chola Foods Pvt', phone: null, metadata: { tier: 'silver' } },
  },
  {
    name: 'clients update with an empty name',
    group: 'clients',
    method: 'PATCH',
    path: `/clients/${clients.bharat}`,
    body: { name: '  ' },
  },
  {
    name: 'clients update to a taken email',
    group: 'clients',
    method: 'PATCH',
    path: `/clients/${clients.bharat}`,
    body: { email: 'acme@parity.test' },
  },
  {
    name: 'clients update with a bad email',
    group: 'clients',
    method: 'PATCH',
    path: `/clients/${clients.bharat}`,
    body: { email: 'bad' },
  },
  {
    name: 'clients update another workspace’s client',
    group: 'clients',
    method: 'PATCH',
    path: `/clients/${clients.other}`,
    body: { name: 'Mine now' },
  },
  {
    name: 'clients update with malformed JSON',
    group: 'clients',
    method: 'PATCH',
    path: `/clients/${clients.bharat}`,
    rawBody: 'nope',
  },
  {
    name: 'clients delete',
    group: 'clients',
    method: 'DELETE',
    path: (c) => `/clients/${c.created.client}`,
  },
  {
    name: 'clients delete again',
    group: 'clients',
    method: 'DELETE',
    path: (c) => `/clients/${c.created.client}`,
  },
  {
    name: 'clients delete another workspace’s client',
    group: 'clients',
    method: 'DELETE',
    path: `/clients/${clients.other}`,
  },
  {
    name: 'clients import',
    group: 'clients',
    method: 'POST',
    path: '/clients/import',
    body: {
      clients: [
        { name: 'Deccan Tea', email: 'Deccan@Parity.test', city: 'Hyderabad', country: 'IN' },
        { name: '', email: 'blank@parity.test' },
        { name: 'Bad Mail', email: 'bad' },
        { name: 'Acme again', email: 'acme@parity.test' },
        { name: 'Deccan twice', email: 'deccan@parity.test' },
        { name: 'Malabar', email: 'malabar@parity.test', company: 'Malabar Co', phone: '123' },
      ],
    },
  },
  {
    name: 'clients import without skipping duplicates',
    group: 'clients',
    method: 'POST',
    path: '/clients/import',
    body: { skipDuplicates: false, clients: [{ name: 'Acme dup', email: 'acme@parity.test' }] },
  },
  {
    name: 'clients import with no array',
    group: 'clients',
    method: 'POST',
    path: '/clients/import',
    body: {},
  },
  {
    name: 'clients import with an empty array',
    group: 'clients',
    method: 'POST',
    path: '/clients/import',
    body: { clients: [] },
  },
  {
    name: 'clients import with malformed JSON',
    group: 'clients',
    method: 'POST',
    path: '/clients/import',
    rawBody: '[',
  },
  { name: 'clients list after changes', group: 'clients', method: 'GET', path: '/clients?limit=3' },

  // ---- /quotes ----
  { name: 'quotes list', group: 'quotes', method: 'GET', path: '/quotes' },
  {
    name: 'quotes list by status',
    group: 'quotes',
    method: 'GET',
    path: '/quotes?status=draft&limit=1&page=2',
  },
  {
    name: 'quotes list with an unknown status',
    group: 'quotes',
    method: 'GET',
    path: '/quotes?status=lost',
  },
  { name: 'quotes list search', group: 'quotes', method: 'GET', path: '/quotes?search=quote%202' },
  {
    name: 'quotes create',
    group: 'quotes',
    method: 'POST',
    path: '/quotes',
    capture: 'quote',
    body: {
      title: 'API quote',
      clientId: clients.acme,
      lineItems: [line, { name: 'Travel', quantity: 1, rate: 799.99 }],
    },
  },
  {
    name: 'quotes create in USD with no lines',
    group: 'quotes',
    method: 'POST',
    path: '/quotes',
    body: { title: 'Empty', clientId: clients.bharat, currency: 'USD' },
  },
  {
    name: 'quotes create without clientId',
    group: 'quotes',
    method: 'POST',
    path: '/quotes',
    body: { title: 'X' },
  },
  {
    name: 'quotes create without title',
    group: 'quotes',
    method: 'POST',
    path: '/quotes',
    body: { clientId: clients.acme },
  },
  {
    name: 'quotes create with a bad currency',
    group: 'quotes',
    method: 'POST',
    path: '/quotes',
    body: { title: 'X', clientId: clients.acme, currency: 'RUPEE' },
  },
  {
    name: 'quotes create for another workspace’s client',
    group: 'quotes',
    method: 'POST',
    path: '/quotes',
    body: { title: 'X', clientId: clients.other },
  },
  {
    name: 'quotes create for an unknown project',
    group: 'quotes',
    method: 'POST',
    path: '/quotes',
    body: { title: 'X', clientId: clients.acme, projectId: 'nope' },
  },
  {
    name: 'quotes create with a negative rate',
    group: 'quotes',
    method: 'POST',
    path: '/quotes',
    body: { title: 'X', clientId: clients.acme, lineItems: [{ name: 'A', quantity: 1, rate: -1 }] },
  },
  {
    name: 'quotes create with a nameless line',
    group: 'quotes',
    method: 'POST',
    path: '/quotes',
    body: { title: 'X', clientId: clients.acme, lineItems: [{ name: ' ', quantity: 1, rate: 1 }] },
  },
  {
    name: 'quotes create with a huge quantity',
    group: 'quotes',
    method: 'POST',
    path: '/quotes',
    body: {
      title: 'X',
      clientId: clients.acme,
      lineItems: [{ name: 'A', quantity: 1_000_001, rate: 1 }],
    },
  },
  {
    name: 'quotes create with a tax rate over 100',
    group: 'quotes',
    method: 'POST',
    path: '/quotes',
    body: {
      title: 'X',
      clientId: clients.acme,
      lineItems: [{ name: 'A', quantity: 1, rate: 1, taxRate: 101 }],
    },
  },
  {
    name: 'quotes create with malformed JSON',
    group: 'quotes',
    method: 'POST',
    path: '/quotes',
    rawBody: '{',
  },
  { name: 'quotes get', group: 'quotes', method: 'GET', path: `/quotes/${quotes.draft}` },
  {
    name: 'quotes get another workspace’s quote',
    group: 'quotes',
    method: 'GET',
    path: `/quotes/${quotes.other}`,
  },
  {
    name: 'quotes update title and lines',
    group: 'quotes',
    method: 'PATCH',
    path: (c) => `/quotes/${c.created.quote}`,
    body: {
      title: 'API quote v2',
      notes: 'n',
      terms: 't',
      lineItems: [{ name: 'Only', quantity: 3, rate: 100, taxRate: 5 }],
    },
  },
  {
    name: 'quotes update with an invalid transition',
    group: 'quotes',
    method: 'PATCH',
    path: `/quotes/${quotes.draft}`,
    body: { status: 'accepted' },
  },
  {
    name: 'quotes update the lines of an accepted quote',
    group: 'quotes',
    method: 'PATCH',
    path: `/quotes/${quotes.accepted}`,
    body: { lineItems: [{ name: 'A', quantity: 1, rate: 1 }] },
  },
  {
    name: 'quotes update with a non-finite quantity',
    group: 'quotes',
    method: 'PATCH',
    path: `/quotes/${quotes.draft}`,
    body: { lineItems: [{ name: 'A', quantity: 'x', rate: 1 }] },
  },
  {
    name: 'quotes update another workspace’s quote',
    group: 'quotes',
    method: 'PATCH',
    path: `/quotes/${quotes.other}`,
    body: { title: 'x' },
  },
  {
    name: 'quotes update status sent to declined',
    group: 'quotes',
    method: 'PATCH',
    path: `/quotes/${quotes.sent}`,
    body: { status: 'declined' },
  },
  {
    name: 'quotes update with malformed JSON',
    group: 'quotes',
    method: 'PATCH',
    path: `/quotes/${quotes.draft}`,
    rawBody: '{]',
  },
  {
    name: 'quotes duplicate',
    group: 'quotes',
    method: 'POST',
    path: `/quotes/${quotes.accepted}/duplicate`,
    capture: 'duplicate',
  },
  {
    name: 'quotes duplicate another workspace’s quote',
    group: 'quotes',
    method: 'POST',
    path: `/quotes/${quotes.other}/duplicate`,
  },
  {
    name: 'quotes send',
    group: 'quotes',
    method: 'POST',
    path: `/quotes/${quotes.draft}/send`,
    body: { message: 'Please review' },
  },
  {
    name: 'quotes send to explicit recipients',
    group: 'quotes',
    method: 'POST',
    path: (c) => `/quotes/${c.created.quote}/send`,
    body: { recipients: ['a@parity.test', 'b@parity.test'] },
  },
  {
    name: 'quotes send with no body',
    group: 'quotes',
    method: 'POST',
    path: (c) => `/quotes/${c.created.duplicate}/send`,
  },
  {
    name: 'quotes send with malformed JSON',
    group: 'quotes',
    method: 'POST',
    path: (c) => `/quotes/${c.created.duplicate}/send`,
    rawBody: '{oops',
  },
  {
    name: 'quotes send an accepted quote',
    group: 'quotes',
    method: 'POST',
    path: `/quotes/${quotes.accepted}/send`,
  },
  {
    name: 'quotes send with an invalid recipient',
    group: 'quotes',
    method: 'POST',
    path: `/quotes/${quotes.draft}/send`,
    body: { recipients: ['ok@parity.test', 'nope'] },
  },
  {
    name: 'quotes send with eleven recipients',
    group: 'quotes',
    method: 'POST',
    path: `/quotes/${quotes.draft}/send`,
    body: { recipients: Array.from({ length: 11 }, (_, i) => `r${i}@parity.test`) },
  },
  {
    name: 'quotes send a zero-total quote',
    group: 'quotes',
    method: 'POST',
    path: `/quotes/${quotes.empty}/send`,
  },
  {
    name: 'quotes send another workspace’s quote',
    group: 'quotes',
    method: 'POST',
    path: `/quotes/${quotes.other}/send`,
  },
  {
    name: 'quotes delete',
    group: 'quotes',
    method: 'DELETE',
    path: (c) => `/quotes/${c.created.quote}`,
  },
  {
    name: 'quotes delete again',
    group: 'quotes',
    method: 'DELETE',
    path: (c) => `/quotes/${c.created.quote}`,
  },
  { name: 'quotes list after changes', group: 'quotes', method: 'GET', path: '/quotes?limit=2' },

  // ---- /invoices ----
  { name: 'invoices list', group: 'invoices', method: 'GET', path: '/invoices' },
  {
    name: 'invoices list by status and client',
    group: 'invoices',
    method: 'GET',
    path: `/invoices?status=paid&clientId=${clients.acme}`,
  },
  {
    name: 'invoices list with an unknown status',
    group: 'invoices',
    method: 'GET',
    path: '/invoices?status=lost',
  },
  {
    name: 'invoices list page 2',
    group: 'invoices',
    method: 'GET',
    path: '/invoices?limit=2&page=2&search=parity',
  },
  {
    name: 'invoices create',
    group: 'invoices',
    method: 'POST',
    path: '/invoices',
    capture: 'invoice',
    body: {
      title: 'API invoice',
      clientId: clients.acme,
      dueDate: '2025-06-30',
      notes: 'n',
      terms: 't',
      lineItems: [line],
    },
  },
  {
    name: 'invoices create without dueDate',
    group: 'invoices',
    method: 'POST',
    path: '/invoices',
    body: { title: 'X', clientId: clients.acme },
  },
  {
    name: 'invoices create with a bad dueDate',
    group: 'invoices',
    method: 'POST',
    path: '/invoices',
    body: { title: 'X', clientId: clients.acme, dueDate: 'soon' },
  },
  {
    name: 'invoices create without title',
    group: 'invoices',
    method: 'POST',
    path: '/invoices',
    body: { clientId: clients.acme, dueDate: '2025-06-30' },
  },
  {
    name: 'invoices create for another workspace’s client',
    group: 'invoices',
    method: 'POST',
    path: '/invoices',
    body: { title: 'X', clientId: clients.other, dueDate: '2025-06-30' },
  },
  {
    name: 'invoices create with a negative quantity',
    group: 'invoices',
    method: 'POST',
    path: '/invoices',
    body: {
      title: 'X',
      clientId: clients.acme,
      dueDate: '2025-06-30',
      lineItems: [{ name: 'A', quantity: -1, rate: 1 }],
    },
  },
  {
    name: 'invoices create with malformed JSON',
    group: 'invoices',
    method: 'POST',
    path: '/invoices',
    rawBody: '"',
  },
  {
    name: 'invoices create in a GST workspace',
    group: 'invoices',
    method: 'POST',
    path: '/invoices',
    auth: 'gst',
    capture: 'gstInvoice',
    body: {
      title: 'GST invoice',
      clientId: PARITY.gstClient,
      dueDate: '2025-06-30',
      lineItems: [
        {
          name: 'Consulting',
          quantity: 2,
          rate: 1000,
          taxRate: 18,
          hsnSac: '998311',
          itemType: 'services',
        },
      ],
    },
  },
  {
    name: 'invoices create in a GST workspace with an unsupported rate',
    group: 'invoices',
    method: 'POST',
    path: '/invoices',
    auth: 'gst',
    body: {
      title: 'GST bad',
      clientId: PARITY.gstClient,
      dueDate: '2025-06-30',
      lineItems: [{ name: 'Odd', quantity: 1, rate: 1, taxRate: 7, hsnSac: '998311' }],
    },
  },
  { name: 'invoices get', group: 'invoices', method: 'GET', path: `/invoices/${invoices.draft}` },
  {
    name: 'invoices get another workspace’s invoice',
    group: 'invoices',
    method: 'GET',
    path: `/invoices/${invoices.other}`,
  },
  {
    name: 'invoices update title and due date',
    group: 'invoices',
    method: 'PATCH',
    path: (c) => `/invoices/${c.created.invoice}`,
    body: { title: 'API invoice v2', dueDate: '2025-07-31' },
  },
  {
    name: 'invoices update lines',
    group: 'invoices',
    method: 'PATCH',
    path: (c) => `/invoices/${c.created.invoice}`,
    body: { lineItems: [{ name: 'Only', quantity: 4, rate: 250, taxRate: 12 }] },
  },
  {
    name: 'invoices update a paid invoice',
    group: 'invoices',
    method: 'PATCH',
    path: `/invoices/${invoices.paid}`,
    body: { title: 'x' },
  },
  {
    name: 'invoices update with an invalid transition',
    group: 'invoices',
    method: 'PATCH',
    path: `/invoices/${invoices.draft}`,
    body: { status: 'paid' },
  },
  {
    name: 'invoices update lines and status together',
    group: 'invoices',
    method: 'PATCH',
    path: `/invoices/${invoices.draft}`,
    body: { status: 'sent', lineItems: [{ name: 'A', quantity: 1, rate: 1 }] },
  },
  {
    name: 'invoices update with a bad due date',
    group: 'invoices',
    method: 'PATCH',
    path: `/invoices/${invoices.draft}`,
    body: { dueDate: 'never' },
  },
  {
    name: 'invoices update sent to overdue',
    group: 'invoices',
    method: 'PATCH',
    path: `/invoices/${invoices.sent}`,
    body: { status: 'overdue' },
  },
  {
    name: 'invoices delete a paid invoice',
    group: 'invoices',
    method: 'DELETE',
    path: `/invoices/${invoices.paid}`,
  },
  {
    name: 'invoices update paid to voided',
    group: 'invoices',
    method: 'PATCH',
    path: `/invoices/${invoices.paid}`,
    body: { status: 'voided' },
  },
  {
    name: 'invoices update a GST draft to sent',
    group: 'invoices',
    method: 'PATCH',
    path: `/invoices/${PARITY.gstInvoiceDraft}`,
    auth: 'gst',
    body: { status: 'sent' },
  },
  {
    name: 'invoices update another workspace’s invoice',
    group: 'invoices',
    method: 'PATCH',
    path: `/invoices/${invoices.other}`,
    body: { title: 'x' },
  },
  {
    name: 'invoices update with malformed JSON',
    group: 'invoices',
    method: 'PATCH',
    path: `/invoices/${invoices.draft}`,
    rawBody: '{,}',
  },
  {
    name: 'invoices send',
    group: 'invoices',
    method: 'POST',
    path: (c) => `/invoices/${c.created.invoice}/send`,
    body: { message: 'Thanks!' },
  },
  {
    name: 'invoices send with an invalid recipient',
    group: 'invoices',
    method: 'POST',
    path: `/invoices/${invoices.draft}/send`,
    body: { recipients: ['nope'] },
  },
  {
    name: 'invoices send a voided invoice',
    group: 'invoices',
    method: 'POST',
    path: `/invoices/${invoices.paid}/send`,
  },
  {
    name: 'invoices send a zero-total invoice',
    group: 'invoices',
    method: 'POST',
    path: `/invoices/${invoices.empty}/send`,
  },
  {
    name: 'invoices send a GST draft missing Rule 46 details',
    group: 'invoices',
    method: 'POST',
    path: (c) => `/invoices/${c.created.gstInvoice}/send`,
    auth: 'gst',
  },
  {
    name: 'invoices send another workspace’s invoice',
    group: 'invoices',
    method: 'POST',
    path: `/invoices/${invoices.other}/send`,
  },
  {
    name: 'invoices from an accepted quote',
    group: 'invoices',
    method: 'POST',
    path: `/invoices/from-quote/${quotes.accepted}`,
    body: { dueDays: 15 },
  },
  {
    name: 'invoices from the same quote again',
    group: 'invoices',
    method: 'POST',
    path: `/invoices/from-quote/${quotes.accepted}`,
  },
  {
    name: 'invoices from a quote with a bad dueDays',
    group: 'invoices',
    method: 'POST',
    path: `/invoices/from-quote/${quotes.sent}`,
    body: { dueDays: 400 },
  },
  {
    name: 'invoices from another workspace’s quote',
    group: 'invoices',
    method: 'POST',
    path: `/invoices/from-quote/${quotes.other}`,
  },
  {
    name: 'invoices delete',
    group: 'invoices',
    method: 'DELETE',
    path: `/invoices/${invoices.empty}`,
  },
  {
    name: 'invoices delete again',
    group: 'invoices',
    method: 'DELETE',
    path: `/invoices/${invoices.empty}`,
  },
  {
    name: 'invoices list after changes',
    group: 'invoices',
    method: 'GET',
    path: '/invoices?limit=3',
  },
];
