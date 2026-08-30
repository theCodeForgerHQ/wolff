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

  // Authentication comes first: a caller without a key learns nothing
  // about how its body would be judged.
  it.each(['/v1/clients', '/v1/leads'])(
    'answers 401, not 400, to %s without a key',
    async (path) => {
      const res = await request(app).post(path).send({ name: 'a\u0000b' });
      expect(res.status).toBe(401);
    }
  );

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

  // Values of the wrong JSON type used to reach Prisma (or `.trim()`, or the
  // email template) and end in a 500. Each is refused by name.
  it.each([
    ['post', '/v1/clients', { name: 5, email: 'typed@robust.test' }, 'name must be a string'],
    ['post', '/v1/clients', { name: 'N', email: ['typed@robust.test'] }, 'email must be a string'],
    [
      'post',
      '/v1/clients',
      { name: 'N', email: 'typed@robust.test', phone: 5 },
      'phone must be a string',
    ],
    [
      'post',
      '/v1/clients',
      { name: 'N', email: 'typed@robust.test', company: {} },
      'company must be a string',
    ],
    ['patch', '/v1/clients/CLIENT', { name: null }, 'name must be a string'],
    ['patch', '/v1/clients/CLIENT', { phone: 5 }, 'phone must be a string'],
    ['patch', '/v1/clients/CLIENT', { address: null }, 'address cannot be null'],
    ['patch', '/v1/clients/CLIENT', { metadata: null }, 'metadata cannot be null'],
    ['post', '/v1/quotes', { title: 'T', clientId: {} }, 'clientId must be a string'],
    ['post', '/v1/quotes', { title: 5, clientId: 'CLIENT' }, 'title must be a string'],
    [
      'post',
      '/v1/quotes',
      { title: 'T', clientId: 'CLIENT', projectId: 5 },
      'projectId must be a string',
    ],
    [
      'post',
      '/v1/quotes',
      { title: 'T', clientId: 'CLIENT', currency: ['U', 'S', 'D'] },
      'currency must be a string',
    ],
    [
      'post',
      '/v1/quotes',
      {
        title: 'T',
        clientId: 'CLIENT',
        lineItems: [{ name: 'A', quantity: 1, rate: 1, description: 5 }],
      },
      'Line item description must be a string',
    ],
    ['patch', '/v1/quotes/QUOTE', { notes: {} }, 'notes must be a string'],
    [
      'patch',
      '/v1/quotes/QUOTE',
      { lineItems: [{ quantity: 1, rate: 1 }] },
      'Line item name is required',
    ],
    ['post', '/v1/quotes/QUOTE/send', { message: 5 }, 'message must be a string'],
    [
      'post',
      '/v1/invoices',
      { title: 'T', clientId: {}, dueDate: '2026-12-31' },
      'clientId must be a string',
    ],
    [
      'post',
      '/v1/invoices',
      { title: 'T', clientId: 'CLIENT', dueDate: '2026-12-31', terms: 5 },
      'terms must be a string',
    ],
    ['patch', '/v1/invoices/INVOICE', { title: [] }, 'title must be a string'],
    [
      'patch',
      '/v1/invoices/INVOICE',
      { lineItems: [{ name: 'A', quantity: 1, rate: 1, hsnSac: 5 }] },
      'Line item hsnSac must be a string',
    ],
    [
      'patch',
      '/v1/invoices/INVOICE',
      { lineItems: [{ name: 'A', quantity: 1, rate: 1, itemType: 'other' }] },
      "Line item itemType must be 'goods' or 'services'",
    ],
    ['post', '/v1/invoices/INVOICE/send', { message: 5 }, 'message must be a string'],
  ] as const)(
    '%s %s refuses a field of the wrong JSON type: %j',
    async (method, path, body, message) => {
      const payload = JSON.parse(JSON.stringify(body).replace('CLIENT', liveClientId));
      const res = await call(
        method,
        path.replace('CLIENT', liveClientId).replace('QUOTE', quoteId).replace('INVOICE', invoiceId)
      ).send(payload);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: message });
    }
  );

  it('POST /v1/clients/import fails a row that is not an object', async () => {
    const res = await call('post', '/v1/clients/import').send({ clients: [null] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      failed: 1,
      errors: [{ row: 1, message: 'name is required' }],
    });
  });

  it('POST /v1/clients/import fails a row whose fields are not strings', async () => {
    const res = await call('post', '/v1/clients/import').send({
      clients: [
        { name: 'List', email: ['list@robust.test'] },
        { name: 'Phone', email: 'phone@robust.test', phone: 5 },
        { name: 'Fine', email: 'fine@robust.test' },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      success: 1,
      failed: 2,
      errors: [
        { row: 1, message: 'Invalid email format' },
        { row: 2, message: 'phone must be a string' },
      ],
    });
  });

  it('POST /v1/clients answers 409 for the email of a deleted client', async () => {
    const res = await call('post', '/v1/clients').send({ name: 'Back', email: 'gone@robust.test' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'A client with this email already exists' });
  });
});
