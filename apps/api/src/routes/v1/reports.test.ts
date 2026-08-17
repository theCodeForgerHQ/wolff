import { randomUUID } from 'node:crypto';
import { request } from '../../testing/request';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestWorkspace, testApp, testDb, type TestWorkspace } from '../../testing/harness';

const auth = (ws: TestWorkspace) => 'Bearer ' + ws.key;

describe.skipIf(!process.env.TEST_DATABASE_URL)('/v1 reports routes (Postgres)', () => {
  const { base, db } = testDb();
  const app = testApp(db);
  let ws: TestWorkspace;

  beforeAll(async () => {
    ws = await createTestWorkspace(base, 'Reports API', ['reports:read']);
    const client = await base.client.create({
      data: { workspaceId: ws.id, name: 'Client', email: `client-${ws.id}@example.test` },
    });
    await base.invoice.create({
      data: {
        workspaceId: ws.id,
        clientId: client.id,
        invoiceNumber: 'INV-RPT-1',
        status: 'sent',
        issueDate: new Date('2026-09-01'),
        dueDate: new Date('2026-09-15'),
        subtotal: 100,
        taxTotal: 18,
        total: 118,
        amountDue: 118,
        currency: 'INR',
      },
    });
  });

  afterAll(async () => {
    await base.invoice.deleteMany({ where: { workspaceId: ws.id } });
    await base.client.deleteMany({ where: { workspaceId: ws.id } });
    await base.workspace.deleteMany({ where: { id: ws.id } });
    await base.$disconnect();
  });

  it('returns receivables ageing with the reports:read scope', async () => {
    const res = await request(app)
      .get('/v1/reports/receivables-ageing')
      .set('Authorization', auth(ws));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ invoiceNumber: 'INV-RPT-1', amountDue: 118 });
  });

  it('returns revenue with the reports:read scope', async () => {
    const res = await request(app).get('/v1/reports/revenue').set('Authorization', auth(ws));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('rejects without the reports:read scope', async () => {
    const limited = await createTestWorkspace(base, 'Reports API Limited', ['leads:read']);

    const res = await request(app)
      .get('/v1/reports/receivables-ageing')
      .set('Authorization', auth(limited));

    expect(res.status).toBe(403);

    await base.workspace.deleteMany({ where: { id: limited.id } });
  });
});
