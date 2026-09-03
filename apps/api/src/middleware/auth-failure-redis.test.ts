import express, { type RequestHandler } from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRedis } from '@wolff/jobs/bullmq';
import { TestRedis } from '@wolff/jobs/testing/redis';
import { request } from '../testing/request';
import { authFailureRateLimit, redisRateLimitStore } from './auth';

/**
 * The failed-authentication limiter against Redis, the store production
 * uses (bootstrap.ts). The in-memory tests in auth.test.ts cannot show what
 * Redis does with a counter whose window has expired.
 */
describe('failed-authentication limit on Redis', () => {
  let container: TestRedis;
  let redis: Redis;
  const store = (prefix: string) => redisRateLimitStore(redis, prefix);
  const limiter = (windowMs?: number) =>
    authFailureRateLimit(store, windowMs === undefined ? undefined : { windowMs });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const appWith = (handler: RequestHandler, windowMs?: number) => {
    const app = express();
    app.get('/x', limiter(windowMs), handler);
    return app;
  };

  /** Every rate-limit key with its TTL in ms (-1: none, -2: gone). */
  const keysWithTtl = async () => {
    const keys = await redis.keys('rl:*');
    return Promise.all(
      keys.map(async (key) => ({ key, value: await redis.get(key), ttl: await redis.pttl(key) }))
    );
  };

  beforeAll(async () => {
    container = await TestRedis.start();
    redis = createRedis(container.url);
  }, 120_000);

  afterAll(async () => {
    redis?.disconnect();
    await container?.kill();
  });

  beforeEach(async () => {
    await redis.flushall();
  });

  it('lets at most 30 of 60 concurrent bad-key requests through', async () => {
    let checked = 0;
    const app = appWith((_req, res) => {
      checked += 1;
      setTimeout(() => res.status(401).json({}), 50);
    });

    const statuses = await Promise.all(
      Array.from({ length: 60 }, async () => (await request(app).get('/x')).status)
    );

    expect(checked).toBeLessThanOrEqual(30);
    expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(30);
    expect(statuses.filter((s) => s !== 401).every((s) => s === 429)).toBe(true);
    expect((await keysWithTtl()).every(({ ttl }) => ttl > 0)).toBe(true);
  });

  it('keeps the slot of a request whose client disconnects', async () => {
    const app = appWith((_req, res) => {
      setTimeout(() => {
        if (!res.destroyed) res.status(401).json({});
      }, 100);
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await Promise.all(
        Array.from(
          // Below the limit, so none is refused (a refused request's slot is
          // given back when its 429 finishes).
          { length: 25 },
          () =>
            new Promise<void>((resolve) => {
              const req = http.get({ host: '127.0.0.1', port, path: '/x' });
              req.on('error', () => resolve());
              req.on('socket', (socket) => {
                socket.on('connect', () => setTimeout(() => req.destroy(), 20));
              });
              req.on('close', () => resolve());
            })
        )
      );
      await sleep(300);

      const [entry] = await keysWithTtl();
      expect(Number(entry?.value)).toBe(25);
      expect(entry?.ttl).toBeGreaterThan(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('gives back the slot of a request that did not fail, leaving the count at 0', async () => {
    const app = appWith((_req, res) => {
      res.json({});
    });

    const statuses: number[] = [];
    for (let i = 0; i < 45; i++) statuses.push((await request(app).get('/x')).status);
    await sleep(50);

    expect(statuses.filter((s) => s !== 200)).toEqual([]);
    const [entry] = await keysWithTtl();
    expect(Number(entry?.value)).toBe(0);
    expect(entry?.ttl).toBeGreaterThan(0);
  });

  it('leaves no key without a TTL when a request finishes after its window expired', async () => {
    // The request reserves in a 200 ms window and answers after 400 ms. A
    // plain DECR on the expired key would create it at -1 with no TTL.
    const app = appWith((_req, res) => {
      setTimeout(() => res.json({}), 400);
    }, 200);

    expect((await request(app).get('/x')).status).toBe(200);
    await sleep(50);

    for (const { key, ttl } of await keysWithTtl()) {
      expect({ key, ttl: ttl > 0 || ttl === -2 }).toEqual({ key, ttl: true });
    }
  });

  it('does not recreate a counter at -1 when it vanished while a request was in flight', async () => {
    // Eviction or a Redis restart inside the window: the release must not
    // create the key with no TTL.
    const app = appWith((_req, res) => {
      setTimeout(() => res.json({}), 200);
    });

    const pending = request(app).get('/x');
    const done = pending.then((r) => r.status);
    await sleep(100);
    await redis.flushall();
    expect(await done).toBe(200);
    await sleep(50);

    expect(await keysWithTtl()).toEqual([]);
  });

  it("does not give back a slot from an earlier window against the next window's failures", async () => {
    // A reserves, the window expires, B fails in the new window, then A
    // finishes. A must not cancel B's failure.
    const app = express();
    app.get('/slow', limiter(300), (_req, res) => {
      setTimeout(() => res.json({}), 500);
    });
    app.get('/fail', limiter(300), (_req, res) => {
      res.status(401).json({});
    });

    const slow = request(app).get('/slow');
    const slowDone = slow.then((r) => r.status);
    await sleep(350);
    expect((await request(app).get('/fail')).status).toBe(401);
    expect(await slowDone).toBe(200);
    await sleep(50);

    const [entry] = await keysWithTtl();
    expect(Number(entry?.value)).toBe(1);
  });
});
