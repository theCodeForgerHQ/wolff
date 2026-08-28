import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEGACY_KEY_SCOPES } from '@wolff/contracts';
import { request } from '../../../testing/request';
import { TEST_DATABASE_URL, issueKey, testApp, testDb } from '../../../testing/harness';

/**
 * Inputs Schemathesis found that made the Next routes (and so the first
 * port) answer 500. Each now gets a 4xx in the routes' own `{ error }` shape.
 */
describe.skipIf(!TEST_DATABASE_URL)('ported /v1 routes on malformed input (Postgres)', () => {
  const { base, db } = testDb();
  const app = testApp(db, { email: { send: async () => {} } });
  let workspaceId = '';
  let key = '';
  let quoteId = '';
  let invoiceId = '';
  let liveClientId = '';

  beforeAll(async () => {
    const ws = await base.workspace.create({
      data: {
        name: 'Robustness',
        slug: `robustness-${Date.now()}`,
        clients: {
          create: [
            { name: 'Live', email: 'live@robust.test' },
            { name: 'Gone', email: 'gone@robust.test', deletedAt: new Date() },
          ],
        },
      },
      include: { clients: true },
    });
    workspaceId = ws.id;
    key = (
      await issueKey(base, ws.id, { scopes: [...LEGACY_KEY_SCOPES], rateLimitPerMin: 100_000 })
    ).key;
    const clientId = ws.clients.find((c) => c.name === 'Live')!.id;
    liveClientId = clientId;
    quoteId = (
      await base.quote.create({ data: { workspaceId, clientId, quoteNumber: 'R-1', total: 10 } })
    ).id;
    invoiceId = (
      await base.invoice.create({
        data: { workspaceId, clientId, invoiceNumber: 'R-1', total: 10, dueDate: new Date() },
      })
    ).id;
  });

  afterAll(async () => {
    await base.workspace.deleteMany({ where: { id: workspaceId } });
    await base.$disconnect();
  });

  const call = (method: 'get' | 'post' | 'patch', path: string) =>
    request(app)[method](path).set('Authorization', `Bearer ${key}`);

  it.each(['/v1/clients', '/v1/quotes', '/v1/invoices'])(
    '%s treats a non-numeric page or limit as the default',
    async (path) => {
      const res = await call('get', `${path}?page=abc&limit=x`);
      expect(res.status).toBe(200);
      expect(res.body.pagination).toMatchObject({ page: 1, limit: 25 });
    }
  );

  it.each(['quotes', 'invoices'])(
    'POST /v1/%s/:id/send refuses recipients that are not a list',
    async (kind) => {
      const id = kind === 'quotes' ? quoteId : invoiceId;
      const res = await call('post', `/v1/${kind}/${id}/send`).send({
        recipients: 'a@robust.test',
      });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'recipients must be a list of email addresses' });
    }
  );

  it.each([
    ['post', '/v1/quotes', { title: 'T', clientId: 'CLIENT', lineItems: [null] }],
    ['patch', '/v1/quotes/QUOTE', { lineItems: [null] }],
    ['patch', '/v1/invoices/INVOICE', { lineItems: [7] }],
  ] as const)('%s %s refuses a line item that is not an object', async (method, path, body) => {
    const payload = JSON.parse(JSON.stringify(body).replace('CLIENT', liveClientId));
    const res = await call(
      method,
      path.replace('QUOTE', quoteId).replace('INVOICE', invoiceId)
    ).send(payload);
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
  });

  it('POST /v1/clients refuses a NUL character (raw JSON text body)', async () => {
    const res = await call('post', '/v1/clients').send({
      name: 'a\u0000b',
      email: 'n@robust.test',
    });
    expect(res.status).toBe(400);
    // The ported routes keep their own error shape.
    expect(res.body).toEqual({ error: 'Text may not contain the NUL character (U+0000)' });
  });

  it.each([
    ['patch', '/v1/quotes/QUOTE'],
    ['patch', '/v1/invoices/INVOICE'],
  ] as const)('%s %s refuses lineItems that are not a list', async (method, path) => {
    const res = await call(
      method,
      path.replace('QUOTE', quoteId).replace('INVOICE', invoiceId)
    ).send({ lineItems: { name: 'x' } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'lineItems must be a list' });
  });

  it.each([
    ['/v1/quotes', { title: 'T', clientId: {} }],
    ['/v1/invoices', { title: 'T', clientId: {}, dueDate: '2026-12-31' }],
    ['/v1/clients', { name: 'N', email: 'typed@robust.test', phone: 5 }],
  ])('POST %s refuses a field of the wrong JSON type', async (path, body) => {
    const res = await call('post', path).send(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request: a field has the wrong type' });
  });

  it('POST /v1/clients answers 409 for the email of a deleted client', async () => {
    const res = await call('post', '/v1/clients').send({ name: 'Back', email: 'gone@robust.test' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'A client with this email already exists' });
  });
});
