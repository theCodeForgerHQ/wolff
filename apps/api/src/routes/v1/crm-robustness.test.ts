import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request } from '../../testing/request';
import {
  TEST_DATABASE_URL,
  createTestWorkspace,
  testApp,
  testDb,
  type TestWorkspace,
} from '../../testing/harness';

/**
 * Requests Schemathesis found that the CRM routes answered with 500. Each
 * is the caller's mistake and now gets a 4xx with the standard envelope.
 */
describe.skipIf(!TEST_DATABASE_URL)('/v1 CRM routes on hostile input (Postgres)', () => {
  const { base, db } = testDb();
  const app = testApp(db);
  let ws: TestWorkspace;
  let pipelineId = '';
  let stageId = '';

  beforeAll(async () => {
    ws = await createTestWorkspace(base, 'CRM robustness', [
      'leads:read',
      'leads:write',
      'deals:read',
      'deals:write',
    ]);
    const res = await post('/v1/pipelines', {
      name: 'P',
      stages: [{ name: 'Open', position: 0, probability: 10, kind: 'open' }],
    });
    pipelineId = res.body.data.id;
    stageId = res.body.data.stages[0].id;
  });

  afterAll(async () => {
    const where = { workspaceId: ws.id };
    await base.dealActivity.deleteMany({ where });
    await base.deal.deleteMany({ where });
    await base.lead.deleteMany({ where });
    await base.client.deleteMany({ where });
    await base.stage.deleteMany({ where });
    await base.pipeline.deleteMany({ where });
    await base.workspace.deleteMany({ where: { id: ws.id } });
    await base.$disconnect();
  });

  function post(path: string, body: unknown) {
    return request(app)
      .post(path)
      .set('Authorization', `Bearer ${ws.key}`)
      .send(body as object);
  }

  const expectClientError = (
    res: { status: number; body: { error?: { code?: string } } },
    status: number
  ) => {
    expect(res.status).toBe(status);
    expect(res.body.error?.code).toBeTypeOf('string');
  };

  it('refuses a NUL character in a text field', async () => {
    expectClientError(await post('/v1/leads', { name: 'a\u0000b' }), 400);
  });

  it('refuses a deal with neither a client nor a lead', async () => {
    expectClientError(await post('/v1/deals', { pipelineId, stageId, title: 'D' }), 400);
  });

  it('refuses a deal in a stage of another pipeline', async () => {
    const res = await post('/v1/deals', {
      pipelineId,
      stageId: randomUUID(),
      leadId: randomUUID(),
      title: 'D',
    });
    expectClientError(res, 404);
  });

  it('refuses a deal for a lead or client that does not exist', async () => {
    expectClientError(
      await post('/v1/deals', { pipelineId, stageId, leadId: randomUUID(), title: 'D' }),
      404
    );
    expectClientError(
      await post('/v1/deals', { pipelineId, stageId, clientId: randomUUID(), title: 'D' }),
      404
    );
  });

  it('refuses a lead owned by someone outside the workspace', async () => {
    expectClientError(await post('/v1/leads', { name: 'L', ownerId: randomUUID() }), 400);
  });

  it('refuses numbers the columns cannot hold', async () => {
    expectClientError(
      await post('/v1/pipelines', {
        name: 'Huge',
        stages: [{ name: 'S', position: 3_000_000_000, probability: 1, kind: 'open' }],
      }),
      400
    );
    const lead = await post('/v1/leads', { name: 'Value' });
    expectClientError(
      await post('/v1/deals', {
        pipelineId,
        stageId,
        leadId: lead.body.data.id,
        title: 'D',
        value: 1e13,
      }),
      400
    );
  });

  it('refuses an unknown lead status in a bulk action', async () => {
    const lead = await post('/v1/leads', { name: 'Bulk' });
    expectClientError(
      await post('/v1/leads/bulk', { ids: [lead.body.data.id], action: 'status', value: 'lost' }),
      400
    );
  });

  it('refuses to replace stages with an id of no stage of the pipeline', async () => {
    const res = await request(app)
      .put(`/v1/pipelines/${pipelineId}/stages`)
      .set('Authorization', `Bearer ${ws.key}`)
      .send({
        stages: [{ id: randomUUID(), name: 'X', position: 0, probability: 0, kind: 'open' }],
      });
    expectClientError(res, 404);
  });

  it('refuses two stages at the same position', async () => {
    const stage = { probability: 0, kind: 'open' };
    expectClientError(
      await post('/v1/pipelines', {
        name: 'Twins',
        stages: [
          { ...stage, name: 'A', position: 1 },
          { ...stage, name: 'B', position: 1 },
        ],
      }),
      400
    );
  });

  it('answers 409 for a lead email that differs only in case', async () => {
    expect((await post('/v1/leads', { name: 'One', email: 'Case@crm.test' })).status).toBe(201);
    expectClientError(await post('/v1/leads', { name: 'Two', email: 'case@crm.test' }), 409);
  });

  it('answers 409 for a second deal on the same lead', async () => {
    const lead = await post('/v1/leads', { name: 'Twice' });
    const deal = { pipelineId, stageId, leadId: lead.body.data.id, title: 'D' };
    expect((await post('/v1/deals', deal)).status).toBe(201);
    expectClientError(await post('/v1/deals', deal), 409);
  });

  it('answers 409 when replacing stages would remove one that holds deals', async () => {
    const res = await request(app)
      .put(`/v1/pipelines/${pipelineId}/stages`)
      .set('Authorization', `Bearer ${ws.key}`)
      .send({ stages: [{ name: 'Only new', position: 5, probability: 0, kind: 'open' }] });
    expectClientError(res, 409);
  });

  it('refuses a deal owner from outside the workspace on update', async () => {
    const lead = await post('/v1/leads', { name: 'Owned' });
    const deal = await post('/v1/deals', {
      pipelineId,
      stageId,
      leadId: lead.body.data.id,
      title: 'D',
    });
    const res = await request(app)
      .patch(`/v1/deals/${deal.body.data.dealId}`)
      .set('Authorization', `Bearer ${ws.key}`)
      .send({ ownerId: randomUUID() });
    expectClientError(res, 400);
  });

  it('answers 409 converting a lead whose email a client already has', async () => {
    await base.client.create({ data: { workspaceId: ws.id, name: 'C', email: 'taken@crm.test' } });
    const lead = await post('/v1/leads', { name: 'Taken', email: 'taken@crm.test' });
    expectClientError(await post(`/v1/leads/${lead.body.data.id}/convert`, {}), 409);
  });

  it('answers 409 converting a lead that already has a deal', async () => {
    const lead = await post('/v1/leads', { name: 'Dealt' });
    await post('/v1/deals', { pipelineId, stageId, leadId: lead.body.data.id, title: 'D' });
    expectClientError(await post(`/v1/leads/${lead.body.data.id}/convert`, {}), 409);
  });
});
