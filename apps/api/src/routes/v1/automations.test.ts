import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TEST_DATABASE_URL,
  createTestWorkspace,
  testApp,
  testDb,
  type TestWorkspace,
} from '../../testing/harness';

describe.skipIf(!TEST_DATABASE_URL)('/v1/automations', () => {
  const { base, db } = testDb();
  const app = testApp(db);
  let ws: TestWorkspace;

  const auth = (key: string) => 'Bearer ' + key;
  const as = (key: string) => ({
    get: (path: string) => request(app).get(path).set('Authorization', auth(key)),
    post: (path: string) => request(app).post(path).set('Authorization', auth(key)),
    patch: (path: string) => request(app).patch(path).set('Authorization', auth(key)),
    delete: (path: string) => request(app).delete(path).set('Authorization', auth(key)),
  });

  beforeAll(async () => {
    ws = await createTestWorkspace(base, 'Automations API', [
      'automations:read',
      'automations:write',
    ]);
  });

  afterAll(async () => {
    await base.automationRun.deleteMany({ where: { workspaceId: ws.id } });
    await base.automation.deleteMany({ where: { workspaceId: ws.id } });
    await base.workspace.deleteMany({ where: { id: ws.id } });
    await base.$disconnect();
  });

  it('creates, lists, gets, updates and deletes an automation', async () => {
    const create = await as(ws.key)
      .post('/v1/automations')
      .send({
        name: 'Overdue invoice reminder',
        trigger: 'invoice.overdue',
        steps: [{ type: 'wait', days: 7 }],
      });
    expect(create.status).toBe(201);
    expect(create.body.data).toMatchObject({
      name: 'Overdue invoice reminder',
      trigger: 'invoice.overdue',
    });
    const id = create.body.data.id;

    const list = await as(ws.key).get('/v1/automations');
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);

    const get = await as(ws.key).get(`/v1/automations/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.data.name).toBe('Overdue invoice reminder');

    const patch = await as(ws.key).patch(`/v1/automations/${id}`).send({ isActive: false });
    expect(patch.status).toBe(200);
    expect(patch.body.data.isActive).toBe(false);

    const del = await as(ws.key).delete(`/v1/automations/${id}`);
    expect(del.status).toBe(204);
  });

  it('rejects an invalid trigger', async () => {
    const res = await as(ws.key)
      .post('/v1/automations')
      .send({
        name: 'Bad',
        trigger: 'invoice.paid',
        steps: [{ type: 'wait', days: 1 }],
      });
    expect(res.status).toBe(400);
  });

  it('approves and rejects a run waiting for approval', async () => {
    const automation = await base.automation.create({
      data: {
        workspaceId: ws.id,
        name: 'Approval test',
        trigger: 'deal.stalled',
        steps: [{ type: 'approval', role: 'owner' }],
      },
    });
    const run = await base.automationRun.create({
      data: {
        workspaceId: ws.id,
        automationId: automation.id,
        subjectId: '00000000-0000-0000-0000-000000000000',
        status: 'waiting_approval',
        currentStep: 0,
      },
    });

    const approve = await as(ws.key).post(`/v1/automations/runs/${run.id}/approve`);
    expect(approve.status).toBe(200);
    expect(approve.body.data.status).toBe('running');

    const run2 = await base.automationRun.create({
      data: {
        workspaceId: ws.id,
        automationId: automation.id,
        subjectId: '00000000-0000-0000-0000-000000000001',
        status: 'waiting_approval',
        currentStep: 0,
      },
    });
    const reject = await as(ws.key).post(`/v1/automations/runs/${run2.id}/reject`);
    expect(reject.status).toBe(200);
    expect(reject.body.data.status).toBe('cancelled');
  });
});
