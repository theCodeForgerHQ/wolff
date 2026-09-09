// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * acceptQuote reads the quote, hashes what it read into the signature and
 * then marks it accepted. An owner edit committed between the read and the
 * update would leave a signature over content the client never saw, so
 * the accept must refuse when the quote changed after it was read. Runs on
 * a real Postgres (TEST_DATABASE_URL): the edit is made from a hook on the
 * read, exactly where the race window is.
 */
const url = process.env.TEST_DATABASE_URL;

const hooks = vi.hoisted(() => ({
  afterSigningRead: null as null | ((quoteId: string) => Promise<void>),
}));

vi.mock('@wolff/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wolff/database')>();
  const base = actual.createPrisma(process.env.TEST_DATABASE_URL);
  const prisma = base.$extends({
    query: {
      quote: {
        async findFirst({ args, query }) {
          const result = await query(args);
          const select = (args as { select?: { lineItems?: unknown } }).select;
          const hook = hooks.afterSigningRead;
          if (hook && select?.lineItems && result) {
            hooks.afterSigningRead = null;
            await hook((result as { id: string }).id);
          }
          return result;
        },
      },
    },
  });
  return { ...actual, prisma };
});

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'user-agent': 'vitest' }),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ limited: false }),
}));
vi.mock('@/lib/notifications/internal', () => ({
  notifyWorkspaceMembers: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/workspace/get-current-workspace', () => ({
  getCurrentUserWorkspace: vi.fn(),
}));

import { prisma } from '@wolff/database';
import { acceptQuote } from '@/lib/quotes/portal-actions';

describe.skipIf(!url)('acceptQuote and a concurrent owner edit (Postgres)', () => {
  const run = randomUUID();
  let workspaceId = '';
  let clientId = '';
  let n = 0;

  beforeAll(async () => {
    const workspace = await prisma.workspace.create({
      data: {
        name: 'Accept race',
        slug: `accept-race-${run}`,
        clients: { create: { name: 'Client', email: `client-${run}@wolff.test` } },
      },
      include: { clients: true },
    });
    workspaceId = workspace.id;
    clientId = workspace.clients[0]!.id;
  });

  afterAll(async () => {
    if (workspaceId) {
      const quotes = await prisma.quote.findMany({ where: { workspaceId }, select: { id: true } });
      const quoteIds = quotes.map((q) => q.id);
      const invoices = await prisma.invoice.findMany({
        where: { workspaceId },
        select: { id: true },
      });
      const invoiceIds = invoices.map((i) => i.id);
      await prisma.paymentSchedule.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
      await prisma.invoiceEvent.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
      await prisma.invoice.deleteMany({ where: { workspaceId } });
      await prisma.quoteEvent.deleteMany({ where: { quoteId: { in: quoteIds } } });
      await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    }
    await prisma.$disconnect();
  });

  const makeQuote = async (settings: object = {}, currency = 'USD') =>
    prisma.quote.create({
      data: {
        workspaceId,
        clientId,
        quoteNumber: `AR-${++n}`,
        title: 'Website',
        status: 'sent',
        currency,
        subtotal: 1000,
        total: 1000,
        settings,
        lineItems: { create: [{ name: 'Build', quantity: 1, rate: 1000, amount: 1000 }] },
      },
    });

  const accept = (accessToken: string) =>
    acceptQuote({
      accessToken,
      signatureData: 'typed:Jane Client',
      signerName: 'Jane Client',
      agreedToTerms: true,
    });

  it('refuses to accept a quote the owner edited after it was read', async () => {
    const quote = await makeQuote();
    hooks.afterSigningRead = async (id) => {
      await prisma.quote.update({
        where: { id },
        data: { total: 5000, subtotal: 5000, terms: 'New terms' },
      });
    };

    const result = await accept(quote.accessToken);

    expect(result.success).toBe(false);
    const after = await prisma.quote.findUniqueOrThrow({ where: { id: quote.id } });
    expect(after.status).toBe('sent');
    expect(after.signedAt).toBeNull();
    expect(after.signatureData).toBeNull();
  });

  it('still accepts an unchanged quote', async () => {
    const quote = await makeQuote();
    const result = await accept(quote.accessToken);
    expect(result.success).toBe(true);
    const after = await prisma.quote.findUniqueOrThrow({ where: { id: quote.id } });
    expect(after.status).not.toBe('sent');
    expect(after.signedAt).not.toBeNull();
  });

  it("describes a fixed deposit in the invoice's currency", async () => {
    const quote = await makeQuote(
      {
        autoConvertToInvoice: true,
        depositRequired: true,
        depositType: 'fixed',
        depositValue: 250,
      },
      'INR'
    );

    const result = await accept(quote.accessToken);

    expect(result).toMatchObject({ success: true, depositRequired: true, depositAmount: 250 });
    const schedule = await prisma.paymentSchedule.findFirstOrThrow({
      where: { invoice: { quoteId: quote.id } },
    });
    expect(schedule.description).not.toContain('$');
    expect(schedule.description).toContain('₹');
  });
});
