import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request } from '../../../testing/request';
import {
  TEST_DATABASE_URL,
  createTestWorkspace,
  testApp,
  testDb,
  type TestWorkspace,
} from '../../../testing/harness';

/**
 * The Next routes checked only that a key was valid. The ports also require
 * the key's scopes; keys backfilled with every scope but
 * webhooks:manage behave as before (the parity suite), others are refused.
 */
describe.skipIf(!TEST_DATABASE_URL)('scopes on the ported /v1 routes (Postgres)', () => {
  const { base, db } = testDb();
  const app = testApp(db);
  let readOnly: TestWorkspace;

  beforeAll(async () => {
    readOnly = await createTestWorkspace(base, 'Legacy scopes', [
      'clients:read',
      'quotes:read',
      'invoices:read',
      'invoices:write',
    ]);
  });

  afterAll(async () => {
    await base.workspace.deleteMany({ where: { id: readOnly.id } });
    await base.$disconnect();
  });

  const as = (method: 'get' | 'post' | 'patch' | 'delete', path: string) =>
    request(app)[method](path).set('Authorization', `Bearer ${readOnly.key}`);

  it('reads with a read scope', async () => {
    for (const path of ['/v1/clients', '/v1/quotes', '/v1/invoices']) {
      expect((await as('get', path)).status, path).toBe(200);
    }
  });

  it.each([
    ['post', '/v1/clients', 'clients:write'],
    ['post', '/v1/clients/import', 'clients:write'],
    ['patch', '/v1/clients/x', 'clients:write'],
    ['delete', '/v1/clients/x', 'clients:write'],
    ['post', '/v1/quotes', 'quotes:write'],
    ['patch', '/v1/quotes/x', 'quotes:write'],
    ['delete', '/v1/quotes/x', 'quotes:write'],
    ['post', '/v1/quotes/x/send', 'quotes:write'],
    ['post', '/v1/quotes/x/duplicate', 'quotes:write'],
    // Converting also changes the quote.
    ['post', '/v1/invoices/from-quote/x', 'quotes:write'],
  ] as const)('%s %s needs %s', async (method, path, scope) => {
    const res = await as(method, path).send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'insufficient_scope' });
    expect(res.body.error.message).toContain(scope);
  });

  it('refuses reads without the read scope', async () => {
    const none = await createTestWorkspace(base, 'Legacy no scopes', []);
    try {
      const res = await request(app).get('/v1/invoices').set('Authorization', `Bearer ${none.key}`);
      expect(res.status).toBe(403);
    } finally {
      await base.workspace.deleteMany({ where: { id: none.id } });
    }
  });
});
