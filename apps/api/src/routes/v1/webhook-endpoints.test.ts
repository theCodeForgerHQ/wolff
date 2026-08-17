import { randomUUID } from 'node:crypto';
import { request } from '../../testing/request';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  TEST_DATABASE_URL,
  createTestWorkspace,
  issueKey,
  testApp,
  testDb,
  type TestWorkspace,
} from '../../testing/harness';

describe.skipIf(!TEST_DATABASE_URL)('/v1/webhook-endpoints (Postgres)', () => {
  const { base, db } = testDb();
  const app = testApp(db);
  let a: TestWorkspace;
  let b: TestWorkspace;
  const as = (ws: TestWorkspace) => ({
    get: (path: string) => request(app).get(path).set('Authorization', `Bearer ${ws.key}`),
    post: (path: string) => request(app).post(path).set('Authorization', `Bearer ${ws.key}`),
    delete: (path: string) => request(app).delete(path).set('Authorization', `Bearer ${ws.key}`),
  });
  const body = { url: 'https://hooks.example.com/in', events: ['invoice.paid'], name: 'Billing' };
  const create = async (ws: TestWorkspace) =>
    (await as(ws).post('/v1/webhook-endpoints').send(body)).body.data;

  beforeAll(async () => {
    a = await createTestWorkspace(base, 'Hooks API A', ['webhooks:manage']);
    b = await createTestWorkspace(base, 'Hooks API B', ['webhooks:manage']);
  });

  afterEach(async () => {
    const where = { workspaceId: { in: [a.id, b.id] } };
    await base.outboxEvent.deleteMany({ where });
    await base.webhookEndpoint.deleteMany({ where });
    await base.idempotencyKey.deleteMany({ where });
  });

  afterAll(async () => {
    await base.workspace.deleteMany({ where: { id: { in: [a.id, b.id] } } });
    await base.$disconnect();
  });

  it('creates an endpoint and returns its secret once', async () => {
    const res = await as(a).post('/v1/webhook-endpoints').send(body);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      name: 'Billing',
      url: 'https://hooks.example.com/in',
      events: ['invoice.paid'],
      isActive: true,
      apiVersion: '2026-10',
      failureCount: 0,
      disabledAt: null,
    });
    expect(res.body.data.secret).toMatch(/^whsec_/);

    const list = await as(a).get('/v1/webhook-endpoints');
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).not.toHaveProperty('secret');
    expect(JSON.stringify(list.body)).not.toContain(res.body.data.secret);
  });

  it('ignores a workspaceId in the body: the key decides the workspace', async () => {
    const res = await as(a)
      .post('/v1/webhook-endpoints')
      .send({ ...body, workspaceId: b.id });

    // Unknown fields are rejected, so the attempt is visible to the caller.
    expect(res.status).toBe(400);
    expect(await base.webhookEndpoint.count({ where: { workspaceId: b.id } })).toBe(0);
  });

  it.each([
    [{ ...body, url: 'http://hooks.example.com/in' }, 'url'],
    [{ ...body, url: 'https://169.254.169.254/latest' }, 'url'],
    [{ ...body, events: [] }, 'events'],
    [{ ...body, events: ['nope'] }, 'events.0'],
    [{ events: ['invoice.paid'] }, 'url'],
  ])('rejects %j with validation_error on %s', async (invalid, field) => {
    const res = await as(a).post('/v1/webhook-endpoints').send(invalid);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    expect(Object.keys(res.body.error.details)).toContain(field);
  });

  it('requires the webhooks:manage scope', async () => {
    const { key } = await issueKey(base, a.id, { scopes: ['invoices:read'] });

    const res = await request(app)
      .get('/v1/webhook-endpoints')
      .set('Authorization', `Bearer ${key}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('insufficient_scope');
  });

  describe('tenant isolation', () => {
    it("answers 404 for another workspace's endpoint on every route, and changes nothing", async () => {
      const mine = await create(a);
      const test = await as(a).post(`/v1/webhook-endpoints/${mine.id}/test`);
      const deliveryId = test.body.data.deliveryId;

      const responses = await Promise.all([
        as(b).delete(`/v1/webhook-endpoints/${mine.id}`),
        as(b).post(`/v1/webhook-endpoints/${mine.id}/test`),
        as(b).get(`/v1/webhook-endpoints/${mine.id}/deliveries`),
        as(b).post(`/v1/webhook-deliveries/${deliveryId}/retry`),
      ]);

      for (const res of responses) {
        expect(res.status).toBe(404);
        expect(res.body).toEqual({
          success: false,
          error: { code: 'not_found', message: 'Not found' },
        });
      }
      expect((await as(b).get('/v1/webhook-endpoints')).body.data).toEqual([]);
      expect(await base.webhookEndpoint.count({ where: { id: mine.id } })).toBe(1);
      expect(await base.webhookDelivery.count({ where: { endpointId: mine.id } })).toBe(1);
    });

    it('answers 404, not 400 or 500, for an id that is not a UUID', async () => {
      const res = await as(a).delete("/v1/webhook-endpoints/1' OR '1'='1");

      expect(res.status).toBe(404);
    });
  });

  it('deletes an endpoint of its own workspace', async () => {
    const mine = await create(a);

    const res = await as(a).delete(`/v1/webhook-endpoints/${mine.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { id: mine.id, deleted: true } });
    expect((await as(a).get('/v1/webhook-endpoints')).body.data).toEqual([]);
  });

  it('queues a test delivery and lists it with cursor pagination', async () => {
    const mine = await create(a);
    for (let i = 0; i < 3; i++) await as(a).post(`/v1/webhook-endpoints/${mine.id}/test`);

    const first = await as(a).get(`/v1/webhook-endpoints/${mine.id}/deliveries?limit=2`);
    const second = await as(a).get(
      `/v1/webhook-endpoints/${mine.id}/deliveries?limit=2&cursor=${first.body.meta.nextCursor}`
    );

    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.data[0]).toMatchObject({
      eventType: 'webhook.test',
      status: 'pending',
      attempts: 0,
    });
    expect(first.body.meta.hasMore).toBe(true);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.meta).toEqual({ hasMore: false, nextCursor: null });
    expect(
      await base.outboxEvent.count({ where: { workspaceId: a.id, type: 'webhook.deliver' } })
    ).toBe(3);
  });

  it('rejects a cursor it did not issue and a limit out of range', async () => {
    const mine = await create(a);

    const cursor = await as(a).get(
      `/v1/webhook-endpoints/${mine.id}/deliveries?cursor=not-a-cursor`
    );
    const limit = await as(a).get(`/v1/webhook-endpoints/${mine.id}/deliveries?limit=1000`);

    expect(cursor.status).toBe(400);
    expect(limit.status).toBe(400);
  });

  it('queues a delivery again on retry', async () => {
    const mine = await create(a);
    const { deliveryId } = (await as(a).post(`/v1/webhook-endpoints/${mine.id}/test`)).body.data;

    const res = await as(a).post(`/v1/webhook-deliveries/${deliveryId}/retry`);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ success: true, data: { deliveryId, status: 'queued' } });
    expect(await base.outboxEvent.count({ where: { aggregateId: deliveryId } })).toBe(2);
  });

  describe('Idempotency-Key', () => {
    const post = (ws: TestWorkspace, key: string, payload: unknown = body) =>
      as(ws)
        .post('/v1/webhook-endpoints')
        .set('Idempotency-Key', key)
        .send(payload as object);

    it('creates once and replays the first response for the same key and request', async () => {
      const key = randomUUID();

      const first = await post(a, key);
      const second = await post(a, key);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      // The signing secret is shown once; the stored copy has it redacted.
      expect(second.body).toEqual({
        ...first.body,
        data: { ...first.body.data, secret: expect.stringContaining('redacted') },
      });
      expect(second.body.data.secret).not.toBe(first.body.data.secret);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(first.headers['idempotent-replayed']).toBeUndefined();
      expect(await base.webhookEndpoint.count({ where: { workspaceId: a.id } })).toBe(1);
    });

    it('creates once when the same request arrives twice at the same moment', async () => {
      const key = randomUUID();

      const results = await Promise.all([post(a, key), post(a, key)]);

      // Which one wins, and whether the other arrives while the first is
      // still running (409) or after it finished (a replay), depends on
      // timing. Either way exactly one endpoint exists and every 201 is the
      // same response.
      const statuses = results.map((r) => r.status).sort();
      expect([
        [201, 201],
        [201, 409],
      ]).toContainEqual(statuses);
      const created = results.filter((r) => r.status === 201).map((r) => r.body.data.id);
      expect(new Set(created).size).toBe(1);
      expect(await base.webhookEndpoint.count({ where: { workspaceId: a.id } })).toBe(1);
    });

    it('answers 409 when the key is reused for a different request', async () => {
      const key = randomUUID();
      await post(a, key);

      const res = await post(a, key, { ...body, name: 'Other' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('conflict');
      expect(await base.webhookEndpoint.count({ where: { workspaceId: a.id } })).toBe(1);
    });

    it('keeps keys of different workspaces apart', async () => {
      const key = randomUUID();

      const first = await post(a, key);
      const second = await post(b, key);

      expect(second.status).toBe(201);
      expect(second.body.data.id).not.toBe(first.body.data.id);
      expect(second.headers['idempotent-replayed']).toBeUndefined();
    });

    it('replays a validation error too, so a retry cannot succeed by accident', async () => {
      const key = randomUUID();

      const first = await post(a, key, { ...body, events: [] });
      const second = await post(a, key, { ...body, events: [] });

      expect([first.status, second.status]).toEqual([400, 400]);
      expect(second.headers['idempotent-replayed']).toBe('true');
    });

    it('runs the request again once the stored response has expired', async () => {
      const key = randomUUID();
      await post(a, key);
      await base.idempotencyKey.updateMany({
        where: { workspaceId: a.id, key },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const res = await post(a, key);

      expect(res.headers['idempotent-replayed']).toBeUndefined();
      expect(await base.webhookEndpoint.count({ where: { workspaceId: a.id } })).toBe(2);
    });

    it('rejects a key longer than 255 characters', async () => {
      const res = await post(a, 'k'.repeat(256));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    });

    it('creates twice without a key', async () => {
      await as(a).post('/v1/webhook-endpoints').send(body);
      await as(a).post('/v1/webhook-endpoints').send(body);

      expect(await base.webhookEndpoint.count({ where: { workspaceId: a.id } })).toBe(2);
    });
  });
});
