import express from 'express';
import type { Store } from 'express-rate-limit';
import { describe, expect, it } from 'vitest';
import { createRequestRedis } from '@wolff/jobs/bullmq';
import { apiKeyRateLimit } from './middleware/auth';
import { request } from './testing/request';

describe('Redis on the request path', () => {
  // A serverless instance thawed with a dead socket must not hang a request
  // until the function's limit (BullMQ's client retries a command forever).
  it('fails a command quickly when Redis cannot be reached', async () => {
    const redis = createRequestRedis('redis://127.0.0.1:1');
    const started = Date.now();
    try {
      await expect(redis.get('anything')).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(6_000);
    } finally {
      redis.disconnect();
    }
  }, 15_000);

  it('lets a request through, rather than failing it, when the rate-limit store errors', async () => {
    const broken = (): Store =>
      ({
        increment: async () => {
          throw new Error('Command timed out');
        },
        decrement: async () => {},
        resetKey: async () => {},
      }) as unknown as Store;
    const app = express();
    app.get('/probe', apiKeyRateLimit(broken), (_req, res) => res.json({ ok: true }));
    const res = await request(app).get('/probe');
    expect(res.status).toBe(200);
  });
});
