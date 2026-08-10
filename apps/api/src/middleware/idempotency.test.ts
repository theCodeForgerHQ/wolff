import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL, testDb } from '../testing/harness';
import { REPLAY_HEADER, idempotency } from './idempotency';

describe.skipIf(!TEST_DATABASE_URL)('Idempotency-Key middleware (Postgres)', () => {
  const { base, db } = testDb();
  let workspaceId = '';
  let runs = 0;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.ctx = { workspaceId, keyId: 'k', scopes: [], actor: 'api_key', rateLimitPerMin: 120 };
    next();
  });
  app.use(idempotency(db));
  app.post('/end', (_req, res) => {
    runs += 1;
    res.status(204).end();
  });
  app.post('/send', (_req, res) => {
    runs += 1;
    res.status(201).send('created');
  });
  app.post('/secret', (_req, res) => {
    runs += 1;
    res
      .status(201)
      .json({ data: { id: 'we_1', secret: 'whsec_shown_once', nested: { secret: 'x' } } });
  });

  const post = (path: string, key: string) =>
    request(app).post(path).set('Idempotency-Key', key).send({ a: 1 });

  beforeAll(async () => {
    const ws = await base.workspace.create({
      data: { name: 'Idempotency', slug: `idem-${randomUUID()}` },
    });
    workspaceId = ws.id;
  });

  afterAll(async () => {
    await base.idempotencyKey.deleteMany({ where: { workspaceId } });
    await base.workspace.deleteMany({ where: { id: workspaceId } });
    await base.$disconnect();
  });

  it.each(['/end', '/send'])(
    'stores the answer of a handler that does not use res.json (%s) and replays it',
    async (path) => {
      const key = randomUUID();
      const first = await post(path, key);
      const before = runs;

      const again = await post(path, key);

      expect(again.status).toBe(first.status);
      expect(again.headers[REPLAY_HEADER.toLowerCase()]).toBe('true');
      expect(runs).toBe(before);
    }
  );

  it('frees a key whose first request never answered, after the lease', async () => {
    const key = randomUUID();
    // What a crashed process leaves behind: claimed, no response, 2 minutes old.
    await base.idempotencyKey.create({
      data: {
        workspaceId,
        key,
        method: 'POST',
        path: '/end',
        requestHash: 'x'.repeat(64),
        expiresAt: new Date(Date.now() + 86_400_000),
        createdAt: new Date(Date.now() - 120_000),
      },
    });

    const res = await post('/end', key);

    expect(res.status).toBe(204);
  });

  it('still refuses a duplicate while the first request is within its lease', async () => {
    const key = randomUUID();
    await base.idempotencyKey.create({
      data: {
        workspaceId,
        key,
        method: 'POST',
        path: '/end',
        requestHash: 'x'.repeat(64),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    expect((await post('/end', key)).status).toBe(409);
  });

  it('does not store a webhook signing secret in the replay copy', async () => {
    const key = randomUUID();

    const first = await post('/secret', key);

    expect(first.body.data.secret).toBe('whsec_shown_once');
    const stored = await base.idempotencyKey.findFirstOrThrow({ where: { workspaceId, key } });
    expect(JSON.stringify(stored.responseBody)).not.toContain('whsec_shown_once');
    expect(JSON.stringify(stored.responseBody)).not.toContain('"x"');
  });
});
