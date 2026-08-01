import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRedis } from '@wolff/jobs/bullmq';
import { TestRedis } from '@wolff/jobs/testing/redis';
import { SECRET_KEY_PREFIX } from '@wolff/core/auth/api-keys';
import { sendData } from '../http';
import {
  TEST_DATABASE_URL,
  createTestWorkspace,
  issueKey,
  testApp,
  testDb,
  type TestWorkspace,
} from '../testing/harness';
import { apiKeyRateLimit, redisRateLimitStore, requireApiKey, requireScopes } from './auth';

describe.skipIf(!TEST_DATABASE_URL)('API key authentication (Postgres)', () => {
  const { base, db } = testDb();
  let workspace: TestWorkspace;
  const app = () =>
    testApp(db, {
      extend: (router) => {
        router.get(
          '/v1/probe',
          requireApiKey(db),
          apiKeyRateLimit(),
          requireScopes('invoices:read'),
          (req, res) => sendData(res, req.ctx)
        );
        router.post(
          '/v1/probe',
          requireApiKey(db),
          requireScopes('invoices:read', 'invoices:write'),
          (req, res) => sendData(res, { workspaceId: req.ctx!.workspaceId })
        );
      },
    });
  const get = (key?: string) => {
    const req = request(app()).get('/v1/probe');
    return key === undefined ? req : req.set('Authorization', `Bearer ${key}`);
  };
  const unauthorized = { success: false, error: { code: 'unauthorized' } };

  beforeAll(async () => {
    workspace = await createTestWorkspace(base, 'Auth Probe', ['invoices:read']);
  });

  afterAll(async () => {
    await base.workspace.deleteMany({ where: { id: workspace.id } });
    await base.$disconnect();
  });

  it('gives the route the workspace, key and scopes of the key', async () => {
    const res = await get(workspace.key);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      workspaceId: workspace.id,
      keyId: workspace.keyId,
      scopes: ['invoices:read'],
      actor: 'api_key',
      rateLimitPerMin: 120,
    });
  });

  it('accepts a key with the current prefix as well as the legacy one', async () => {
    const { key } = await issueKey(base, workspace.id, {
      scopes: ['invoices:read'],
      prefix: SECRET_KEY_PREFIX,
    });

    expect((await get(key)).status).toBe(200);
  });

  it.each([
    ['no Authorization header', undefined],
    ['an empty bearer token', ''],
    ['a token that is not a key', 'hello'],
    ['an unknown key', 'qc_sk_0000000000000000000000000000000000000000'],
  ])('answers 401 in the envelope for %s', async (_name, key) => {
    const res = await get(key);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject(unauthorized);
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  it('does not accept the key through Basic auth or a query parameter', async () => {
    const basic = await request(app())
      .get('/v1/probe')
      .set('Authorization', `Basic ${Buffer.from(`${workspace.key}:`).toString('base64')}`);
    const query = await request(app()).get(`/v1/probe?api_key=${workspace.key}`);

    expect(basic.status).toBe(401);
    expect(query.status).toBe(401);
  });

  it('rejects a revoked key and an expired key', async () => {
    const revoked = await issueKey(base, workspace.id, { scopes: ['invoices:read'] });
    await base.apiKey.update({ where: { id: revoked.id }, data: { revokedAt: new Date() } });
    const expired = await issueKey(base, workspace.id, { scopes: ['invoices:read'] });
    await base.apiKey.update({
      where: { id: expired.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    expect((await get(revoked.key)).body).toMatchObject(unauthorized);
    expect((await get(expired.key)).body).toMatchObject(unauthorized);
  });

  it('rejects a publishable key on a private route', async () => {
    const { key } = await issueKey(base, workspace.id, {
      kind: 'publishable',
      prefix: SECRET_KEY_PREFIX.replace('_sk_', '_pk_'),
      scopes: ['invoices:read'],
    });

    expect((await get(key)).status).toBe(401);
  });

  it('answers 403 insufficient_scope when the key lacks one of the required scopes', async () => {
    const res = await request(app())
      .post('/v1/probe')
      .set('Authorization', `Bearer ${workspace.key}`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'insufficient_scope', message: 'This API key lacks the scope invoices:write' },
    });
  });

  it('limits each key to its own rate per minute and says when to retry', async () => {
    const slow = await issueKey(base, workspace.id, {
      scopes: ['invoices:read'],
      rateLimitPerMin: 2,
    });
    const limited = app();
    const call = (key: string) =>
      request(limited).get('/v1/probe').set('Authorization', `Bearer ${key}`);

    expect((await call(slow.key)).status).toBe(200);
    expect((await call(slow.key)).status).toBe(200);
    const third = await call(slow.key);

    expect(third.status).toBe(429);
    expect(third.body).toMatchObject({ success: false, error: { code: 'rate_limited' } });
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(third.headers['retry-after'])).toBeLessThanOrEqual(60);
    // Another key is counted separately.
    expect((await call(workspace.key)).status).toBe(200);
  });

  it('shares the count between instances through Redis, under the rl: prefix', async () => {
    const container = await TestRedis.start();
    const redis = createRedis(container.url);
    try {
      const slow = await issueKey(base, workspace.id, {
        scopes: ['invoices:read'],
        rateLimitPerMin: 2,
      });
      const instance = () =>
        testApp(db, {
          extend: (router) => {
            router.get(
              '/v1/probe',
              requireApiKey(db),
              apiKeyRateLimit(redisRateLimitStore(redis)),
              (_req, res) => sendData(res, {})
            );
          },
        });
      const call = (target: ReturnType<typeof instance>) =>
        request(target).get('/v1/probe').set('Authorization', `Bearer ${slow.key}`);

      expect((await call(instance())).status).toBe(200);
      expect((await call(instance())).status).toBe(200);
      expect((await call(instance())).status).toBe(429);
      expect(await redis.keys('rl:*')).toEqual([`rl:key:${slow.id}`]);
    } finally {
      redis.disconnect();
      await container.kill();
    }
  }, 120_000);
});
