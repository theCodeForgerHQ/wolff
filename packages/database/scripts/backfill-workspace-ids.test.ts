import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrisma } from '../src/client';
import { backfillWorkspaceIds } from './backfill-workspace-ids';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('backfill-workspace-ids (Postgres)', () => {
  const db = createPrisma(url);
  const run = randomUUID();
  let workspaceId = '';
  let invoiceId = '';
  let endpointId = '';
  let paymentId = '';
  let deliveryId = '';

  beforeAll(async () => {
    const workspace = await db.workspace.create({
      data: {
        name: 'Workspace Backfill',
        slug: `workspace-backfill-${run}`,
        clients: { create: { name: 'Client', email: `client-${run}@example.test` } },
        webhookEndpoints: { create: { url: 'https://example.test/hook', secret: 'whsec_x' } },
      },
      include: { clients: true, webhookEndpoints: true },
    });
    workspaceId = workspace.id;
    endpointId = workspace.webhookEndpoints[0]!.id;
    const invoice = await db.invoice.create({
      data: {
        workspaceId,
        clientId: workspace.clients[0]!.id,
        invoiceNumber: 'INV-BACKFILL',
        dueDate: new Date('2026-12-01'),
      },
    });
    invoiceId = invoice.id;
    // Rows as the previous release writes them: no workspace_id.
    paymentId = (
      await db.payment.create({ data: { invoiceId, amount: 10, paymentMethod: 'card' } })
    ).id;
    deliveryId = (
      await db.webhookDelivery.create({
        data: { endpointId, eventType: 'invoice.paid', payload: {} },
      })
    ).id;
  });

  afterAll(async () => {
    await db.payment.deleteMany({ where: { invoiceId } });
    await db.invoice.deleteMany({ where: { id: invoiceId } });
    if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
    await db.$disconnect();
  });

  it('copies the workspace from the invoice and from the endpoint', async () => {
    const counts = await backfillWorkspaceIds(db);

    expect(counts.payments).toBeGreaterThanOrEqual(1);
    expect(counts.webhookDeliveries).toBeGreaterThanOrEqual(1);
    const payment = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
    const delivery = await db.webhookDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(payment.workspaceId).toBe(workspaceId);
    expect(delivery.workspaceId).toBe(workspaceId);
  });

  it('leaves the rows as they are on a second run', async () => {
    await backfillWorkspaceIds(db);

    const payment = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.workspaceId).toBe(workspaceId);
    // Only NULLs are candidates, so the statement no longer matches this row.
    expect(await db.payment.count({ where: { invoiceId, workspaceId: null } })).toBe(0);
  });
});
