import express, { type RequestHandler } from 'express';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRedis } from '@wolff/jobs/bullmq';
import { TestRedis } from '@wolff/jobs/testing/redis';
import { PUBLISHABLE_KEY_PREFIX } from '@wolff/core/auth/api-keys';
import { request } from '../testing/request';
import {
  TEST_DATABASE_URL,
  createTestWorkspace,
  issueKey,
  testDb,
  type TestWorkspace,
} from '../testing/harness';
import {
  authFailureRateLimit,
  redisRateLimitStore,
  requireApiKey,
  requirePublishableKey,
  type RateLimitStoreFactory,
} from './auth';

/**
 * A request that authenticated gives its failed-auth slot back when the key
 * check passes, not when its response finishes. Before, a slow endpoint
 * held the slot for its whole duration, and more than 30 authenticated
 * requests in flight from one address got 429 (the k6 run's failures).
 */
describe.skipIf(!TEST_DATABASE_URL)('failed-auth slot of an authenticated request', () => {
  const { base, db } = testDb();
  let workspace: TestWorkspace;
  let secret: string;
  let publishable: string;
  let container: TestRedis;
  let redis: Redis;
  const ORIGIN = 'https://client.example.com';
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const slow: RequestHandler = (_req, res) => {
    setTimeout(() => res.json({}), 1_500);
  };

  beforeAll(async () => {
    workspace = await createTestWorkspace(base, 'Auth Slots', []);
    secret = (await issueKey(base, workspace.id, { scopes: [] })).key;
    publishable = (
      await issueKey(base, workspace.id, {
        kind: 'publishable',
        prefix: PUBLISHABLE_KEY_PREFIX,
        allowedOrigins: [ORIGIN],
      })
    ).key;
    container = await TestRedis.start();
    redis = createRedis(container.url);
  }, 120_000);

  afterAll(async () => {
    redis?.disconnect();
    await container?.kill();
    await base.workspace.deleteMany({ where: { id: workspace.id } });
    await base.$disconnect();
  });

  /** 45 requests, one every 15 ms, each in flight for 1.5 s: all overlap. */
  const overlapping = async (send: () => Promise<{ status: number }>) => {
    const pending: Promise<number>[] = [];
    for (let i = 0; i < 45; i++) {
      pending.push(send().then((r) => r.status));
      await sleep(15);
    }
    return Promise.all(pending);
  };

  const stores: [string, () => RateLimitStoreFactory | undefined][] = [
    ['memory', () => undefined],
    ['Redis', () => (prefix) => redisRateLimitStore(redis, prefix)],
  ];

  for (const [name, store] of stores) {
    it(`does not refuse 45 overlapping slow requests with a valid secret key (${name})`, async () => {
      await redis.flushall();
      const app = express();
      app.get('/s', authFailureRateLimit(store()), requireApiKey(db), slow);

      const statuses = await overlapping(() =>
        request(app).get('/s').set('Authorization', `Bearer ${secret}`)
      );

      expect(statuses.filter((s) => s !== 200)).toEqual([]);
    }, 30_000);

    it(`does not refuse 45 overlapping slow requests with a valid publishable key (${name})`, async () => {
      await redis.flushall();
      const app = express();
      app.get('/p', authFailureRateLimit(store()), requirePublishableKey(db), slow);

      const statuses = await overlapping(() =>
        request(app).get('/p').set('X-Publishable-Key', publishable).set('Origin', ORIGIN)
      );

      expect(statuses.filter((s) => s !== 200)).toEqual([]);
    }, 30_000);

    it(`still refuses the 31st bad key while the good ones are in flight (${name})`, async () => {
      await redis.flushall();
      const app = express();
      app.get('/s', authFailureRateLimit(store()), requireApiKey(db), slow);

      const statuses: number[] = [];
      for (let i = 0; i < 31; i++) {
        statuses.push(
          (await request(app).get('/s').set('Authorization', `Bearer qc_sk_wrong${i}`)).status
        );
      }

      expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
      expect(statuses[30]).toBe(429);
    }, 30_000);
  }
});
