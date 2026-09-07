import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEGACY_KEY_SCOPES } from '@wolff/contracts';
import { request } from '../../../testing/request';
import { TEST_DATABASE_URL, issueKey, testApp, testDb } from '../../../testing/harness';

/**
 * A quote the client accepted or signed is a contract: PATCH /v1/quotes/:id
 * must not rewrite its title, notes, terms or lines. Auto-convert moves an
 * accepted quote to 'converted', so the guard cannot be on 'accepted' alone.
 */
describe.skipIf(!TEST_DATABASE_URL)('PATCH /v1/quotes/:id on a signed quote (Postgres)', () => {
  const { base, db } = testDb();
  const app = testApp(db, { email: { send: async () => {} } });
  let workspaceId = '';
  let clientId = '';
  let key = '';

  beforeAll(async () => {
    const ws = await base.workspace.create({
      data: {
        name: 'Signed quotes',
        slug: `signed-quotes-${Date.now()}`,
        clients: { create: [{ name: 'Buyer', email: 'buyer@signed.test' }] },
      },
      include: { clients: true },
    });
    workspaceId = ws.id;
    clientId = ws.clients[0]!.id;
    key = (
      await issueKey(base, ws.id, { scopes: [...LEGACY_KEY_SCOPES], rateLimitPerMin: 100_000 })
    ).key;
  });

  afterAll(async () => {
    await base.workspace.deleteMany({ where: { id: workspaceId } });
    await base.$disconnect();
  });

  let n = 0;
  const makeQuote = async (data: { status: string; signedAt?: Date }) =>
    (
      await base.quote.create({
        data: {
          workspaceId,
          clientId,
          quoteNumber: `S-${++n}`,
          title: 'Original',
          subtotal: 100,
          total: 100,
          ...data,
          lineItems: { create: [{ name: 'Work', quantity: 1, rate: 100, amount: 100 }] },
        },
      })
    ).id;

  const patch = (id: string, body: object) =>
    request(app).patch(`/v1/quotes/${id}`).set('Authorization', `Bearer ${key}`).send(body);

  it.each([
    ['converted', { status: 'converted' }],
    ['accepted', { status: 'accepted' }],
    ['signed but still sent', { status: 'sent', signedAt: new Date() }],
  ] as const)('refuses to rewrite the lines of a %s quote', async (_label, state) => {
    const id = await makeQuote(state);
    const res = await patch(id, { lineItems: [{ name: 'Work', quantity: 1, rate: 1 }] });
    expect(res.status).toBe(400);
    const quote = await base.quote.findUniqueOrThrow({
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
      const quote = await base.quote.findUniqueOrThrow({ where: { id } });
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
    expect(res.body.title).toBe('Edited');
  });

  it('still allows a status transition on a signed sent quote', async () => {
    const id = await makeQuote({ status: 'sent', signedAt: new Date() });
    const res = await patch(id, { status: 'accepted' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('accepted');
  });
});
