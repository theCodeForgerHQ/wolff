import { request } from '../testing/request';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
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
import {
  apiKeyRateLimit,
  authFailureRateLimit,
  redisRateLimitStore,
  requireApiKey,
  requireScopes,
} from './auth';

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
      rateLimitPerMin: 100_000,
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

  it('allows a burst of 20 requests, then spreads the rest of the minute', async () => {
    const steady = await issueKey(base, workspace.id, {
      scopes: ['invoices:read'],
      rateLimitPerMin: 120,
    });
    const limited = app();
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      statuses.push(
        (await request(limited).get('/v1/probe').set('Authorization', `Bearer ${steady.key}`))
          .status
      );
    }

    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  it('slows down a client that keeps presenting bad keys', async () => {
    const guarded = testApp(db, {
      extend: (router) => {
        router.get('/v1/guarded', authFailureRateLimit(), requireApiKey(db), (_req, res) =>
          sendData(res, {})
        );
      },
    });
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      statuses.push(
        (await request(guarded).get('/v1/guarded').set('Authorization', `Bearer qc_sk_wrong${i}`))
          .status
      );
    }

    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  // On Vercel the edge replaces X-Forwarded-For with the caller's address,
  // directly and through the web app's /api/v1 rewrite alike (checked live
  // on 2026-10-06), and the app trusts that one hop. One caller's bad keys
  // must not lock out another caller.
  it('counts failed keys per client address, not per proxy', async () => {
    const app = testApp(db);
    const from = (ip: string) =>
      request(app)
        .get('/v1/clients')
        .set('X-Forwarded-For', ip)
        .set('Authorization', 'Bearer qc_sk_wrong');
    for (let i = 0; i < 30; i++) expect((await from('203.0.113.7')).status).toBe(401);

    expect((await from('203.0.113.7')).status).toBe(429);
    // A forged entry in front of the proxy's own does not give a new count.
    expect((await from('9.9.9.9, 203.0.113.7')).status).toBe(429);
    expect((await from('198.51.100.9')).status).toBe(401);
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
              apiKeyRateLimit((prefix) => redisRateLimitStore(redis, prefix)),
              (_req, res) => sendData(res, {})
            );
          },
        });
      const call = (target: ReturnType<typeof instance>) =>
        request(target).get('/v1/probe').set('Authorization', `Bearer ${slow.key}`);

      expect((await call(instance())).status).toBe(200);
      expect((await call(instance())).status).toBe(200);
      expect((await call(instance())).status).toBe(429);
      expect((await redis.keys('rl:*')).sort()).toEqual([
        `rl:burst:${slow.id}`,
        `rl:key:${slow.id}`,
      ]);
    } finally {
      redis.disconnect();
      await container.kill();
    }
  }, 120_000);
});

describe('failed-authentication limit under concurrency', () => {
  // A parallel burst of bad keys from one address must not get more than
  // 30 tries: every request reserves a slot when it arrives, before the
  // key check, so concurrent requests cannot all read a count below 30.
  it('lets at most 30 of 60 concurrent bad-key requests reach the key check', async () => {
    let checked = 0;
    const app = express();
    app.get('/deny', authFailureRateLimit(), (_req, res) => {
      checked += 1;
      setTimeout(() => res.status(401).json({ success: false }), 50);
    });

    const statuses = await Promise.all(
      Array.from({ length: 60 }, async () => (await request(app).get('/deny')).status)
    );

    expect(checked).toBeLessThanOrEqual(30);
    expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(30);
    expect(statuses.filter((s) => s !== 401).every((s) => s === 429)).toBe(true);
  });

  it('keeps the slot of a request whose client disconnects before the answer', async () => {
    // Aborting each guess early must not give its slot back.
    const app = express();
    app.get('/deny', authFailureRateLimit(), (_req, res) => {
      setTimeout(() => {
        if (!res.destroyed) res.status(401).json({ success: false });
      }, 100);
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await Promise.all(
        Array.from(
          { length: 60 },
          () =>
            new Promise<void>((resolve) => {
              const req = http.get({ host: '127.0.0.1', port, path: '/deny' });
              req.on('error', () => resolve());
              req.on('socket', (socket) => {
                socket.on('connect', () => setTimeout(() => req.destroy(), 20));
              });
              req.on('close', () => resolve());
            })
        )
      );
      // Let the server see every close.
      await new Promise((resolve) => setTimeout(resolve, 200));

      const status = await new Promise<number>((resolve, reject) => {
        http
          .get({ host: '127.0.0.1', port, path: '/deny' }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          })
          .on('error', reject);
      });
      expect(status).toBe(429);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('gives back the slot of a request that authenticated', async () => {
    const app = express();
    app.get('/ok', authFailureRateLimit(), (_req, res) => {
      res.json({ ok: true });
    });

    const statuses: number[] = [];
    for (let i = 0; i < 45; i++) statuses.push((await request(app).get('/ok')).status);

    expect(statuses.filter((s) => s !== 200)).toEqual([]);
  });

  it('still refuses an address after 30 failures in the window', async () => {
    const app = express();
    app.get('/deny', authFailureRateLimit(), (_req, res) => {
      res.status(401).json({ success: false });
    });

    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await request(app).get('/deny')).status);

    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
    expect(statuses[30]).toBe(429);
    expect(statuses.length).toBe(31);
  });
});
