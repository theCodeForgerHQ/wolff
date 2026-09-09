// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * A quote the client accepted or signed is a contract: PATCH
 * /api/v1/quotes/:id must not rewrite its title, notes, terms or lines.
 * Auto-convert moves an accepted quote to 'converted', so the guard cannot
 * be on 'accepted' alone. The same guard as the API's (signed-quote.test.ts
 * in apps/api), on a real Postgres (TEST_DATABASE_URL).
 */
const url = process.env.TEST_DATABASE_URL;

const auth = vi.hoisted(() => ({ workspaceId: '' }));

vi.mock('@wolff/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wolff/database')>();
  return { ...actual, prisma: actual.createPrisma(process.env.TEST_DATABASE_URL) };
});

vi.mock('@/lib/api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/auth')>();
  return {
    ...actual,
    authenticateApiRequest: async () => ({
      context: { workspaceId: auth.workspaceId, apiKeyId: 'test', scopes: [] },
    }),
  };
});

import { prisma } from '@wolff/database';
import { PATCH } from '@/app/api/v1/quotes/[id]/route';

describe.skipIf(!url)('PATCH /api/v1/quotes/:id on a signed quote (Postgres)', () => {
  const run = randomUUID();
  let workspaceId = '';
  let clientId = '';
  let n = 0;

  beforeAll(async () => {
    const ws = await prisma.workspace.create({
      data: {
        name: 'Signed quotes (Next)',
        slug: `signed-quotes-next-${run}`,
        clients: { create: [{ name: 'Buyer', email: `buyer-${run}@signed.test` }] },
      },
      include: { clients: true },
    });
    workspaceId = ws.id;
    auth.workspaceId = ws.id;
    clientId = ws.clients[0]!.id;
  });

  afterAll(async () => {
    if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.$disconnect();
  });

  const makeQuote = async (data: { status: string; signedAt?: Date }) =>
    (
      await prisma.quote.create({
        data: {
          workspaceId,
          clientId,
          quoteNumber: `SN-${++n}`,
          title: 'Original',
          subtotal: 100,
          total: 100,
          ...data,
          lineItems: { create: [{ name: 'Work', quantity: 1, rate: 100, amount: 100 }] },
        },
      })
    ).id;

  const patch = (id: string, body: object) =>
    PATCH(
      new NextRequest(`http://localhost/api/v1/quotes/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      }),
      { params: Promise.resolve({ id }) }
    );

  it.each([
    ['converted', { status: 'converted' }],
    ['accepted', { status: 'accepted' }],
    ['signed but still sent', { status: 'sent', signedAt: new Date() }],
  ] as const)('refuses to rewrite the lines of a %s quote', async (_label, state) => {
    const id = await makeQuote(state);
    const res = await patch(id, { lineItems: [{ name: 'Work', quantity: 1, rate: 1 }] });
    expect(res.status).toBe(400);
    const quote = await prisma.quote.findUniqueOrThrow({
      where: { id },
      include: { lineItems: true },
    });
    expect(Number(quote.total)).toBe(100);
    expect(quote.lineItems.map((l) => Number(l.rate))).toEqual([100]);
  });

  it.each(['title', 'notes', 'terms'])(
    'refuses to rewrite the %s of a converted quote',
    async (field) => {
      const id = await makeQuote({ status: 'converted' });
      const res = await patch(id, { [field]: 'Changed' });
      expect(res.status).toBe(400);
      const quote = await prisma.quote.findUniqueOrThrow({ where: { id } });
      expect(quote[field as 'title' | 'notes' | 'terms']).not.toBe('Changed');
    }
  );

  it('still edits an unsigned draft', async () => {
    const id = await makeQuote({ status: 'draft' });
    const res = await patch(id, {
      title: 'Edited',
      lineItems: [{ name: 'W', quantity: 2, rate: 5 }],
    });
    expect(res.status).toBe(200);
    const quote = await prisma.quote.findUniqueOrThrow({ where: { id } });
    expect(quote.title).toBe('Edited');
    expect(Number(quote.total)).toBe(10);
  });
});
