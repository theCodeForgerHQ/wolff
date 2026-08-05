import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  TEST_DATABASE_URL,
  createTestWorkspace,
  issueKey,
  testApp,
  testDb,
  type TestWorkspace,
} from '../../testing/harness';

describe.skipIf(!TEST_DATABASE_URL)('/v1 CRM routes (Postgres)', () => {
  const { base, db } = testDb();
  const app = testApp(db);
  let a: TestWorkspace;
  let b: TestWorkspace;

  const auth = (ws: TestWorkspace) => 'Bearer ' + ws.key;
  const as = (ws: TestWorkspace) => ({
    get: (path: string) => request(app).get(path).set('Authorization', auth(ws)),
    post: (path: string) => request(app).post(path).set('Authorization', auth(ws)),
    patch: (path: string) => request(app).patch(path).set('Authorization', auth(ws)),
    put: (path: string) => request(app).put(path).set('Authorization', auth(ws)),
    delete: (path: string) => request(app).delete(path).set('Authorization', auth(ws)),
  });

  beforeAll(async () => {
    a = await createTestWorkspace(base, 'CRM API A', [
      'leads:read',
      'leads:write',
      'deals:read',
      'deals:write',
    ]);
    b = await createTestWorkspace(base, 'CRM API B', [
      'leads:read',
      'leads:write',
      'deals:read',
      'deals:write',
    ]);
  });

  afterEach(async () => {
    const where = { workspaceId: { in: [a.id, b.id] } };
    await base.dealActivity.deleteMany({ where });
    await base.deal.deleteMany({ where });
    await base.lead.deleteMany({ where });
    await base.stage.deleteMany({ where });
    await base.pipeline.deleteMany({ where });
    await base.idempotencyKey.deleteMany({ where });
  });

  afterAll(async () => {
    await base.workspace.deleteMany({ where: { id: { in: [a.id, b.id] } } });
    await base.$disconnect();
  });

  describe('/leads', () => {
    it('creates, lists, gets, updates and deletes a lead', async () => {
      const create = await as(a).post('/v1/leads').send({
        name: 'Priya Sharma',
        email: 'priya@example.com',
        company: 'Kaveri Studio',
        source: 'api',
      });
      expect(create.status).toBe(201);
      expect(create.body.data).toMatchObject({
        name: 'Priya Sharma',
        email: 'priya@example.com',
        company: 'Kaveri Studio',
        source: 'api',
        status: 'new',
      });

      const id = create.body.data.id;

      const list = await as(a).get('/v1/leads');
      expect(list.status).toBe(200);
      expect(list.body.data).toHaveLength(1);

      const get = await as(a).get(`/v1/leads/${id}`);
      expect(get.status).toBe(200);
      expect(get.body.data.email).toBe('priya@example.com');

      const update = await as(a).patch(`/v1/leads/${id}`).send({ status: 'qualified', score: 75 });
      expect(update.status).toBe(200);
      expect(update.body.data.status).toBe('qualified');
      expect(update.body.data.score).toBe(75);

      const del = await as(a).delete(`/v1/leads/${id}`);
      expect(del.status).toBe(200);
      expect(del.body.data).toEqual({ id, deleted: true });

      const get2 = await as(a).get(`/v1/leads/${id}`);
      expect(get2.status).toBe(404);
    });

    it('rejects a duplicate active email with 409', async () => {
      const first = await as(a).post('/v1/leads').send({ name: 'First', email: 'dup@example.com' });
      expect(first.status).toBe(201);

      const second = await as(a)
        .post('/v1/leads')
        .send({ name: 'Second', email: 'dup@example.com' });
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('conflict');
    });

    it('filters leads by status and source', async () => {
      await as(a).post('/v1/leads').send({ name: 'A', status: 'new', source: 'widget' });
      await as(a).post('/v1/leads').send({ name: 'B', status: 'qualified', source: 'manual' });

      const filtered = await as(a).get('/v1/leads?status=qualified&source=manual');
      expect(filtered.status).toBe(200);
      expect(filtered.body.data).toHaveLength(1);
      expect(filtered.body.data[0].name).toBe('B');
    });

    it('supports bulk status update and delete', async () => {
      const l1 = (await as(a).post('/v1/leads').send({ name: 'L1' })).body.data;
      const l2 = (await as(a).post('/v1/leads').send({ name: 'L2' })).body.data;

      const bulk = await as(a)
        .post('/v1/leads/bulk')
        .send({
          ids: [l1.id, l2.id],
          action: 'status',
          value: 'contacted',
        });
      expect(bulk.status).toBe(200);
      expect(bulk.body.data.updated).toBe(2);

      const updated = await base.lead.findMany({ where: { workspaceId: a.id } });
      expect(updated.every((l) => l.status === 'contacted')).toBe(true);

      const del = await as(a)
        .post('/v1/leads/bulk')
        .send({
          ids: [l1.id, l2.id],
          action: 'delete',
        });
      expect(del.status).toBe(200);
      expect(del.body.data.updated).toBe(2);
    });

    it('converts a lead to a client and deal', async () => {
      const lead = (
        await as(a).post('/v1/leads').send({ name: 'Convert Me', email: 'conv@example.com' })
      ).body.data;

      const convert = await as(a)
        .post(`/v1/leads/${lead.id}/convert`)
        .send({ value: 5000, currency: 'INR' });
      expect(convert.status).toBe(201);
      expect(convert.body.data).toMatchObject({
        leadId: lead.id,
        clientId: expect.any(String),
        dealId: expect.any(String),
      });

      const leadAfter = await base.lead.findUnique({ where: { id: lead.id } });
      expect(leadAfter?.status).toBe('converted');
      expect(leadAfter?.clientId).toBe(convert.body.data.clientId);

      const deal = await base.deal.findUnique({ where: { id: convert.body.data.dealId } });
      expect(deal?.value.toNumber()).toBe(5000);
      expect(deal?.currency).toBe('INR');
    });

    it('isolates leads between workspaces', async () => {
      const mine = (await as(a).post('/v1/leads').send({ name: 'Mine' })).body.data;

      const crossGet = await as(b).get(`/v1/leads/${mine.id}`);
      expect(crossGet.status).toBe(404);

      const crossPatch = await as(b).patch(`/v1/leads/${mine.id}`).send({ name: 'Hacked' });
      expect(crossPatch.status).toBe(404);

      const crossDelete = await as(b).delete(`/v1/leads/${mine.id}`);
      expect(crossDelete.status).toBe(404);
    });

    it('requires the leads:read scope', async () => {
      const { key } = await issueKey(base, a.id, { scopes: ['deals:read'] });
      const res = await request(app)
        .get('/v1/leads')
        .set('Authorization', 'Bearer ' + key);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('insufficient_scope');
    });
  });

  describe('/pipelines', () => {
    it('creates a pipeline with stages and lists it', async () => {
      const create = await as(a)
        .post('/v1/pipelines')
        .send({
          name: 'Recruitment',
          stages: [
            { name: 'Sourced', position: 0, probability: 10, kind: 'open' },
            { name: 'Hired', position: 1, probability: 100, kind: 'won' },
          ],
        });
      expect(create.status).toBe(201);
      expect(create.body.data.stages).toHaveLength(2);

      const list = await as(a).get('/v1/pipelines');
      expect(list.status).toBe(200);
      expect(list.body.data).toHaveLength(1);

      const get = await as(a).get(`/v1/pipelines/${create.body.data.id}`);
      expect(get.status).toBe(200);
      expect(get.body.data.name).toBe('Recruitment');
    });

    it('replaces stages in one transaction', async () => {
      const pipeline = (
        await as(a)
          .post('/v1/pipelines')
          .send({
            name: 'Sales',
            stages: [{ name: 'Old', position: 0, probability: 0, kind: 'open' }],
          })
      ).body.data;

      const oldStageId = pipeline.stages[0].id;
      const replace = await as(a)
        .put(`/v1/pipelines/${pipeline.id}/stages`)
        .send({
          stages: [
            { id: oldStageId, name: 'New', position: 0, probability: 25, kind: 'open' },
            { name: 'Closed', position: 1, probability: 100, kind: 'won' },
          ],
        });
      expect(replace.status).toBe(200);
      expect(replace.body.data.stages).toHaveLength(2);
      expect(replace.body.data.stages[0].name).toBe('New');
    });
  });

  describe('/deals', () => {
    async function defaultPipeline(ws: TestWorkspace) {
      const list = await as(ws).get('/v1/pipelines');
      return list.body.data[0];
    }

    async function makeClient(ws: TestWorkspace) {
      return base.client.create({
        data: {
          workspaceId: ws.id,
          name: 'Client',
          email: `client-${randomUUID()}@example.com`,
          countryCode: 'US',
        },
      });
    }

    it('creates and moves a deal through stages', async () => {
      const pipeline = await defaultPipeline(a);
      const openStage = pipeline.stages.find((s: { kind: string }) => s.kind === 'open');
      const wonStage = pipeline.stages.find((s: { kind: string }) => s.kind === 'won');
      const client = await makeClient(a);

      const create = await as(a).post('/v1/deals').send({
        pipelineId: pipeline.id,
        stageId: openStage.id,
        clientId: client.id,
        title: 'Big Project',
        value: 10000,
        currency: 'USD',
      });
      expect(create.status).toBe(201);
      const dealId = create.body.data.dealId;

      const move = await as(a).post(`/v1/deals/${dealId}/move`).send({ stageId: wonStage.id });
      expect(move.status).toBe(200);
      expect(move.body.data.newStageId).toBe(wonStage.id);
      expect(move.body.data.wonAt).not.toBeNull();

      const get = await as(a).get(`/v1/deals/${dealId}`);
      expect(get.status).toBe(200);
      expect(get.body.data.stageId).toBe(wonStage.id);
    });

    it('updates a deal', async () => {
      const pipeline = await defaultPipeline(a);
      const stage = pipeline.stages[0];
      const client = await makeClient(a);
      const create = await as(a).post('/v1/deals').send({
        pipelineId: pipeline.id,
        stageId: stage.id,
        clientId: client.id,
        title: 'Deal',
      });
      const dealId = create.body.data.dealId;

      const update = await as(a).patch(`/v1/deals/${dealId}`).send({
        title: 'Renamed Deal',
        value: 2500,
      });
      expect(update.status).toBe(200);
      expect(update.body.data.title).toBe('Renamed Deal');
      expect(update.body.data.value).toBe('2500');
    });

    it('deletes a deal', async () => {
      const pipeline = await defaultPipeline(a);
      const stage = pipeline.stages[0];
      const client = await makeClient(a);
      const create = await as(a).post('/v1/deals').send({
        pipelineId: pipeline.id,
        stageId: stage.id,
        clientId: client.id,
        title: 'Goner',
      });
      const dealId = create.body.data.dealId;

      const del = await as(a).delete(`/v1/deals/${dealId}`);
      expect(del.status).toBe(200);

      const get = await as(a).get(`/v1/deals/${dealId}`);
      expect(get.status).toBe(404);
    });

    it('isolates deals between workspaces', async () => {
      const pipelineA = await defaultPipeline(a);
      const client = await makeClient(a);
      const create = await as(a).post('/v1/deals').send({
        pipelineId: pipelineA.id,
        stageId: pipelineA.stages[0].id,
        clientId: client.id,
        title: 'Mine',
      });
      const dealId = create.body.data.dealId;

      const cross = await as(b).get(`/v1/deals/${dealId}`);
      expect(cross.status).toBe(404);
    });

    it('creates a draft quote from a deal', async () => {
      const key = await issueKey(base, a.id, {
        scopes: ['deals:read', 'deals:write', 'quotes:write'],
      });
      const pipeline = await defaultPipeline(a);
      const client = await makeClient(a);
      const create = await request(app)
        .post('/v1/deals')
        .set('Authorization', 'Bearer ' + key.key)
        .send({
          pipelineId: pipeline.id,
          stageId: pipeline.stages[0].id,
          clientId: client.id,
          title: 'Website project',
          value: 5000,
          currency: 'INR',
        });
      expect(create.status).toBe(201);
      const dealId = create.body.data.dealId;

      const quote = await request(app)
        .post(`/v1/deals/${dealId}/quote`)
        .set('Authorization', 'Bearer ' + key.key)
        .send({ title: 'Website quote' });
      expect(quote.status).toBe(201);
      expect(quote.body.data).toMatchObject({
        quoteNumber: expect.stringMatching(/^QT-/),
      });

      const deal = await request(app)
        .get(`/v1/deals/${dealId}`)
        .set('Authorization', 'Bearer ' + key.key);
      expect(deal.body.data.quoteId).toBe(quote.body.data.quoteId);
    });
  });
});
