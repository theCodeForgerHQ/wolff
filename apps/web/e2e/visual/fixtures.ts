import { prisma } from '@wolff/database';

/**
 * UUID copies of seeded demo documents for the visual suite.
 *
 * The demo seed uses readable ids (`demo-quote-2`), but the dashboard detail
 * routes only accept UUIDs, so seeded documents can't be opened there. Until
 * the deterministic demo seed lands (Phase 3), the suite clones one quote
 * and one invoice under fixed ids, tokens and dates. Each run deletes and
 * recreates the clones, so portal visits from earlier runs leave no trace,
 * and the copy goes through jsonb, so it keeps working when the schema gains
 * columns.
 */
export const VISUAL = {
  // Opened in the dashboard.
  quoteId: '00000000-0000-4000-8000-00000000a001',
  invoiceId: '00000000-0000-4000-8000-00000000a002',
  // Opened in the client portal. Separate documents, because every portal
  // visit appends a "viewed" event that the dashboard detail pages render.
  portalQuoteId: '00000000-0000-4000-8000-00000000a003',
  portalQuoteToken: '00000000-0000-4000-8000-00000000b003',
  portalInvoiceId: '00000000-0000-4000-8000-00000000a004',
  portalInvoiceToken: '00000000-0000-4000-8000-00000000b004',
} as const;

// Seed dates are relative to "now"; pin the clones so their pages render
// the same text (and width) whatever day the database was seeded. The
// expiry and due dates are far in the future: a date that passes turns the
// quote "expired" and the invoice "overdue", and the pages change with it
// (the first pinned expiry, 2026-10-01, did exactly that on 2026-10-02).
const FIXED = '2026-09-01T09:00:00Z';
const FAR_FUTURE = '2099-10-01T09:00:00Z';
const QUOTE_DATES = {
  issue_date: FIXED,
  expiration_date: FAR_FUTURE,
  sent_at: FIXED,
  viewed_at: FIXED,
  created_at: FIXED,
  updated_at: FIXED,
};
const INVOICE_DATES = {
  issue_date: FIXED,
  due_date: FAR_FUTURE,
  sent_at: FIXED,
  viewed_at: FIXED,
  created_at: FIXED,
  updated_at: FIXED,
};

const tokenFor = (id: string) => id.replace(/a(\d{3})$/, 'b$1');

async function cloneDocument(opts: {
  table: 'quotes' | 'invoices';
  itemsTable: 'quote_line_items' | 'invoice_line_items';
  fk: 'quote_id' | 'invoice_id';
  sourceId: string;
  id: string;
  token: string;
  overrides: Record<string, string | null>;
}) {
  const { table, itemsTable, fk, sourceId, id, token, overrides } = opts;
  const patch = JSON.stringify({ ...overrides, id, access_token: token });
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${table}
       SELECT (jsonb_populate_record(NULL::${table}, to_jsonb(src) || $1::jsonb)).*
       FROM ${table} src WHERE src.id = $2`,
    patch,
    sourceId
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${itemsTable}
       SELECT (jsonb_populate_record(NULL::${itemsTable}, to_jsonb(li)
         || jsonb_build_object('id', md5(li.id || $1)::uuid::text, '${fk}', $1::text))).*
       FROM ${itemsTable} li WHERE li.${fk} = $2`,
    id,
    sourceId
  );
}

async function deleteClones(
  table: string,
  itemsTable: string,
  eventsTable: string,
  fk: string,
  ids: string[]
) {
  await prisma.$executeRawUnsafe(`DELETE FROM ${eventsTable} WHERE ${fk} = ANY($1::text[])`, ids);
  await prisma.$executeRawUnsafe(`DELETE FROM ${itemsTable} WHERE ${fk} = ANY($1::text[])`, ids);
  await prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE id = ANY($1::text[])`, ids);
}

export async function ensureVisualFixtures() {
  const quotes = [
    [VISUAL.quoteId, 'Q-V001'],
    [VISUAL.portalQuoteId, 'Q-V002'],
  ] as const;
  const invoices = [
    [VISUAL.invoiceId, 'INV-V001'],
    [VISUAL.portalInvoiceId, 'INV-V002'],
  ] as const;

  // Start every run from a clean copy.
  await deleteClones(
    'quotes',
    'quote_line_items',
    'quote_events',
    'quote_id',
    quotes.map(([id]) => id)
  );
  await deleteClones(
    'invoices',
    'invoice_line_items',
    'invoice_events',
    'invoice_id',
    invoices.map(([id]) => id)
  );

  for (const [id, quoteNumber] of quotes) {
    await cloneDocument({
      table: 'quotes',
      itemsTable: 'quote_line_items',
      fk: 'quote_id',
      sourceId: 'demo-quote-2',
      id,
      token: tokenFor(id),
      overrides: { ...QUOTE_DATES, quote_number: quoteNumber },
    });
  }
  for (const [id, invoiceNumber] of invoices) {
    await cloneDocument({
      table: 'invoices',
      itemsTable: 'invoice_line_items',
      fk: 'invoice_id',
      sourceId: 'demo-invoice-2',
      id,
      token: tokenFor(id),
      overrides: { ...INVOICE_DATES, invoice_number: invoiceNumber, quote_id: null },
    });
  }
}
