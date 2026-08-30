import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEGACY_KEY_SCOPES } from '@wolff/contracts';
import { request } from '../../../testing/request';
import {
  TEST_DATABASE_URL,
  createTestWorkspace,
  issueKey,
  testApp,
  testDb,
  type TestWorkspace,
} from '../../../testing/harness';

type Method = 'get' | 'post' | 'patch' | 'delete';

/**
 * The 20 operations of the ported route files and the scope each requires.
 * The ids do not exist: a route whose scope check is missing answers 404 or
 * 400 instead of 403, so each case fails when its check is removed.
 */
const OPERATIONS: Array<[Method, string, string]> = [
  ['get', '/v1/clients', 'clients:read'],
  ['post', '/v1/clients', 'clients:write'],
  ['post', '/v1/clients/import', 'clients:write'],
  ['get', '/v1/clients/x', 'clients:read'],
  ['patch', '/v1/clients/x', 'clients:write'],
  ['delete', '/v1/clients/x', 'clients:write'],
  ['get', '/v1/quotes', 'quotes:read'],
  ['post', '/v1/quotes', 'quotes:write'],
  ['get', '/v1/quotes/x', 'quotes:read'],
  ['patch', '/v1/quotes/x', 'quotes:write'],
  ['delete', '/v1/quotes/x', 'quotes:write'],
  ['post', '/v1/quotes/x/send', 'quotes:write'],
  ['post', '/v1/quotes/x/duplicate', 'quotes:write'],
  ['get', '/v1/invoices', 'invoices:read'],
  ['post', '/v1/invoices', 'invoices:write'],
  ['post', '/v1/invoices/from-quote/x', 'invoices:write'],
  ['get', '/v1/invoices/x', 'invoices:read'],
  ['patch', '/v1/invoices/x', 'invoices:write'],
  ['delete', '/v1/invoices/x', 'invoices:write'],
  ['post', '/v1/invoices/x/send', 'invoices:write'],
];

/**
 * The Next routes checked only that a key was valid. The ports also require
 * the key's scopes. Each operation is called with a key that
 * holds every other scope, so a check that is missing, or that asks for the
 * wrong scope, fails its case.
 */
describe.skipIf(!TEST_DATABASE_URL)('scopes on the ported /v1 routes (Postgres)', () => {
  const { base, db } = testDb();
  const app = testApp(db);
  let workspace: TestWorkspace;
  /** A key per scope, holding every legacy scope but that one. */
  const keyWithout = new Map<string, string>();

  beforeAll(async () => {
    workspace = await createTestWorkspace(base, 'Legacy scopes', [...LEGACY_KEY_SCOPES]);
    for (const scope of new Set(OPERATIONS.map(([, , s]) => s).concat('quotes:write'))) {
      const scopes = LEGACY_KEY_SCOPES.filter((s) => s !== scope);
      const { key } = await issueKey(base, workspace.id, { scopes, rateLimitPerMin: 100_000 });
      keyWithout.set(scope, key);
    }
  });

  afterAll(async () => {
    await base.workspace.deleteMany({ where: { id: workspace.id } });
    await base.$disconnect();
  });

  const call = (method: Method, path: string, key: string) =>
    request(app)[method](path).set('Authorization', `Bearer ${key}`).send({});

  it('covers the 20 ported operations', () => {
    expect(OPERATIONS).toHaveLength(20);
  });

  it.each(OPERATIONS)('%s %s needs %s', async (method, path, scope) => {
    const res = await call(method, path, keyWithout.get(scope)!);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({
      code: 'insufficient_scope',
      message: `This API key lacks the scope ${scope}`,
    });
  });

  // Converting also changes the quote, so it needs both write scopes.
  it('POST /v1/invoices/from-quote/:id also needs quotes:write', async () => {
    const res = await call('post', '/v1/invoices/from-quote/x', keyWithout.get('quotes:write')!);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('This API key lacks the scope quotes:write');
  });

  it('passes the scope check with every legacy scope', async () => {
    for (const [method, path] of OPERATIONS) {
      const res = await call(method, path, workspace.key);
      expect(res.status, `${method} ${path}`).not.toBe(403);
    }
  });
});
