import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_SCOPES } from '@wolff/contracts';
import { TenantScopeError } from '@wolff/database';
import { bootstrap } from '../../bootstrap';
import {
  TEST_DATABASE_URL,
  createTestWorkspace,
  testApp,
  testConfig,
  testDb,
  type TestWorkspace,
} from '../../testing/harness';

/**
 * A key of workspace A can neither read nor change anything of
 * workspace B, whatever ids it sends. Every route that takes an id (or ids
 * in the body) is called with B's ids and A's key; each must answer as for
 * an id that does not exist, and B's rows must be unchanged afterwards.
 */
describe.skipIf(!TEST_DATABASE_URL)('cross-tenant isolation of /v1 (Postgres)', () => {
  const { base, db } = testDb();
  const app = testApp(db);
  let a: TestWorkspace;
  let b: TestWorkspace;
  const theirs = {
    lead: '',
    pipeline: '',
    stage: '',
    deal: '',
    endpoint: '',
    automation: '',
    run: '',
    invoice: '',
  };

  const as = (key: string) => ({
    get: (path: string) => request(app).get(path).set('Authorization', `Bearer ${key}`),
    post: (path: string, body: object = {}) =>
      request(app)
        .post(path)
        .set('Authorization', `Bearer ${key}`)
        .set('Idempotency-Key', randomUUID())
        .send(body),
    patch: (path: string, body: object) =>
      request(app).patch(path).set('Authorization', `Bearer ${key}`).send(body),
    put: (path: string, body: object) =>
      request(app).put(path).set('Authorization', `Bearer ${key}`).send(body),
    delete: (path: string) => request(app).delete(path).set('Authorization', `Bearer ${key}`),
  });

  const snapshot = async () =>
    JSON.stringify(
      await Promise.all([
        base.lead.findUniqueOrThrow({ where: { id: theirs.lead } }),
        base.pipeline.findUniqueOrThrow({ where: { id: theirs.pipeline } }),
        base.stage.findMany({
          where: { pipelineId: theirs.pipeline },
          orderBy: { position: 'asc' },
        }),
        base.deal.findUniqueOrThrow({ where: { id: theirs.deal } }),
        base.webhookEndpoint.findUniqueOrThrow({ where: { id: theirs.endpoint } }),
        base.automation.findUniqueOrThrow({ where: { id: theirs.automation } }),
        base.automationRun.findUniqueOrThrow({ where: { id: theirs.run } }),
        base.invoice.findUniqueOrThrow({ where: { id: theirs.invoice } }),
        base.payment.count({ where: { invoiceId: theirs.invoice } }),
      ])
    );

  beforeAll(async () => {
    a = await createTestWorkspace(base, 'Tenant A', [...API_SCOPES]);
    b = await createTestWorkspace(base, 'Tenant B', [...API_SCOPES]);
    const lead = await base.lead.create({
      data: { workspaceId: b.id, name: 'B lead', email: `b-${randomUUID()}@example.test` },
    });
    const pipeline = await base.pipeline.create({ data: { workspaceId: b.id, name: 'B sales' } });
    const stage = await base.stage.create({
      data: { workspaceId: b.id, pipelineId: pipeline.id, name: 'New', position: 0 },
    });
    const deal = await base.deal.create({
      data: {
        workspaceId: b.id,
        pipelineId: pipeline.id,
        stageId: stage.id,
        title: 'B deal',
        value: 100,
      },
    });
    const endpoint = await base.webhookEndpoint.create({
      data: {
        workspaceId: b.id,
        name: 'B hook',
        url: 'https://b.example.test/hook',
        secret: 'whsec_b',
        events: ['invoice.paid'],
      },
    });
    const automation = await base.automation.create({
      data: {
        workspaceId: b.id,
        name: 'B automation',
        trigger: 'deal.stalled',
        steps: [{ type: 'approval', role: 'member' }],
        isActive: false,
      },
    });
    const run = await base.automationRun.create({
      data: {
        workspaceId: b.id,
        automationId: automation.id,
        subjectId: deal.id,
        status: 'waiting_approval',
      },
    });
    const client = await base.client.create({
      data: { workspaceId: b.id, name: 'B client', email: `bc-${randomUUID()}@example.test` },
    });
    const invoice = await base.invoice.create({
      data: {
        workspaceId: b.id,
        clientId: client.id,
        invoiceNumber: 'B-1',
        status: 'sent',
        dueDate: new Date('2026-12-01'),
        total: 100,
        amountDue: 100,
        currency: 'INR',
      },
    });
    Object.assign(theirs, {
      lead: lead.id,
      pipeline: pipeline.id,
      stage: stage.id,
      deal: deal.id,
      endpoint: endpoint.id,
      automation: automation.id,
      run: run.id,
      invoice: invoice.id,
    });
  });

  afterAll(async () => {
    for (const ws of [a, b]) {
      await base.automationRun.deleteMany({ where: { workspaceId: ws.id } });
      await base.automation.deleteMany({ where: { workspaceId: ws.id } });
      await base.deal.deleteMany({ where: { workspaceId: ws.id } });
      await base.stage.deleteMany({ where: { workspaceId: ws.id } });
      await base.pipeline.deleteMany({ where: { workspaceId: ws.id } });
      await base.lead.deleteMany({ where: { workspaceId: ws.id } });
      await base.webhookEndpoint.deleteMany({ where: { workspaceId: ws.id } });
      await base.payment.deleteMany({ where: { workspaceId: ws.id } });
      await base.invoice.deleteMany({ where: { workspaceId: ws.id } });
      await base.client.deleteMany({ where: { workspaceId: ws.id } });
      await base.idempotencyKey.deleteMany({ where: { workspaceId: ws.id } });
      await base.workspace.deleteMany({ where: { id: ws.id } });
    }
    await base.$disconnect();
  });

  const calls = (): Array<[string, () => request.Test]> => {
    const k = as(a.key);
    return [
      ['GET lead', () => k.get(`/v1/leads/${theirs.lead}`)],
      ['PATCH lead', () => k.patch(`/v1/leads/${theirs.lead}`, { name: 'taken' })],
      ['DELETE lead', () => k.delete(`/v1/leads/${theirs.lead}`)],
      ['GET pipeline', () => k.get(`/v1/pipelines/${theirs.pipeline}`)],
      ['PATCH pipeline', () => k.patch(`/v1/pipelines/${theirs.pipeline}`, { name: 'taken' })],
      [
        'PUT pipeline stages',
        () =>
          k.put(`/v1/pipelines/${theirs.pipeline}/stages`, {
            stages: [{ name: 'Only', position: 0, probability: 10, kind: 'open' }],
          }),
      ],
      ['GET deal', () => k.get(`/v1/deals/${theirs.deal}`)],
      ['PATCH deal', () => k.patch(`/v1/deals/${theirs.deal}`, { title: 'taken' })],
      ['DELETE deal', () => k.delete(`/v1/deals/${theirs.deal}`)],
      ['POST deal move', () => k.post(`/v1/deals/${theirs.deal}/move`, { stageId: theirs.stage })],
      ['DELETE webhook endpoint', () => k.delete(`/v1/webhook-endpoints/${theirs.endpoint}`)],
      ['POST webhook endpoint test', () => k.post(`/v1/webhook-endpoints/${theirs.endpoint}/test`)],
      ['GET automation', () => k.get(`/v1/automations/${theirs.automation}`)],
      [
        'PATCH automation',
        () => k.patch(`/v1/automations/${theirs.automation}`, { isActive: true }),
      ],
      ['DELETE automation', () => k.delete(`/v1/automations/${theirs.automation}`)],
      ['GET automation run', () => k.get(`/v1/automations/runs/${theirs.run}`)],
      [
        'POST invoice payment link',
        () => k.post(`/v1/invoices/${theirs.invoice}/payment-links`, {}),
      ],
    ];
  };

  const CALLS = [
    'GET lead',
    'PATCH lead',
    'DELETE lead',
    'GET pipeline',
    'PATCH pipeline',
    'PUT pipeline stages',
    'GET deal',
    'PATCH deal',
    'DELETE deal',
    'POST deal move',
    'DELETE webhook endpoint',
    'POST webhook endpoint test',
    'GET automation',
    'PATCH automation',
    'DELETE automation',
    'GET automation run',
    'POST invoice payment link',
  ];

  it('covers every call listed', () => {
    expect(calls().map(([name]) => name)).toEqual(CALLS);
  });

  it.each(CALLS)('%s with an id of another workspace: 404', async (name) => {
    const call = calls().find(([n]) => n === name)![1];
    const before = await snapshot();

    const res = await call();

    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(await snapshot()).toBe(before);
  });

  it('ignores ids of another workspace in a bulk action and in a deal move', async () => {
    const before = await snapshot();
    const ownPipeline = await as(a.key).post('/v1/pipelines', { name: 'A sales' });
    const ownStage = ownPipeline.body.data?.stages?.[0]?.id as string | undefined;

    await as(a.key).post('/v1/leads/bulk', { ids: [theirs.lead], action: 'delete' });
    await as(a.key).post('/v1/leads/bulk', {
      ids: [theirs.lead],
      action: 'status',
      value: 'disqualified',
    });
    const move = await as(b.key).post(`/v1/deals/${theirs.deal}/move`, {
      stageId: ownStage ?? randomUUID(),
    });

    // B moving its own deal onto A's stage is refused too.
    expect(move.status).toBeGreaterThanOrEqual(400);
    expect(await snapshot()).toBe(before);
  });

  it('lists only the caller workspace', async () => {
    for (const path of ['/v1/leads', '/v1/deals', '/v1/pipelines', '/v1/automations']) {
      const res = await as(a.key).get(path);
      expect(JSON.stringify(res.body), path).not.toMatch(/B lead|B deal|B sales|B automation/);
    }
  });

  it('runs every request on a client that refuses a query without a workspace', async () => {
    // The guard is the net under all of the above; the API's real client
    // must have it switched on.
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    const { db: appDb, close } = bootstrap(testConfig());
    process.env.DATABASE_URL = previous;
    try {
      await expect(appDb.invoice.findMany({ where: { status: 'sent' } })).rejects.toBeInstanceOf(
        TenantScopeError
      );
      await expect(appDb.lead.findUnique({ where: { id: theirs.lead } })).rejects.toBeInstanceOf(
        TenantScopeError
      );
    } finally {
      await close();
    }
  });
});
