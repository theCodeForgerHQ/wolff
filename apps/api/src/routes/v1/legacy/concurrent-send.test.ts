import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEGACY_KEY_SCOPES } from '@wolff/contracts';
import { request } from '../../../testing/request';
import { TEST_DATABASE_URL, issueKey, testApp, testDb } from '../../../testing/harness';

/**
 * Two sends of one draft invoice at once. Both read `draft`, both email
 * (the provider deduplicates by idempotency key), but only one may issue
 * the invoice: one `sent` event and one PDF render, not two.
 */
describe.skipIf(!TEST_DATABASE_URL)('concurrent sends of a draft invoice (Postgres)', () => {
  const { base, db } = testDb();
  // Slow enough that both requests read the invoice before either updates it.
  const app = testApp(db, {
    email: { send: () => new Promise((resolve) => setTimeout(resolve, 300)) },
  });
  let workspaceId = '';
  let key = '';
  let invoiceId = '';

  beforeAll(async () => {
    const ws = await base.workspace.create({
      data: {
        name: 'Concurrent send',
        slug: `concurrent-send-${Date.now()}`,
        clients: { create: { name: 'C', email: 'c@concurrent.test' } },
      },
      include: { clients: true },
    });
    workspaceId = ws.id;
    key = (await issueKey(base, ws.id, { scopes: [...LEGACY_KEY_SCOPES], rateLimitPerMin: 1_000 }))
      .key;
    invoiceId = (
      await base.invoice.create({
        data: {
          workspaceId,
          clientId: ws.clients[0]!.id,
          invoiceNumber: 'CS-1',
          total: 100,
          subtotal: 100,
          amountDue: 100,
          dueDate: new Date('2026-12-01'),
        },
      })
    ).id;
  });

  afterAll(async () => {
    await base.outboxEvent.deleteMany({ where: { workspaceId } });
    await base.workspace.deleteMany({ where: { id: workspaceId } });
    await base.$disconnect();
  });

  it('issues the invoice once: one sent event and one PDF render', async () => {
    const send = () =>
      request(app)
        .post(`/v1/invoices/${invoiceId}/send`)
        .set('Authorization', `Bearer ${key}`)
        .send({});

    const statuses = (await Promise.all([send(), send()])).map((r) => r.status);

    expect(statuses).toEqual([200, 200]);
    expect((await base.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe(
      'sent'
    );
    const events = await base.invoiceEvent.findMany({ where: { invoiceId } });
    expect(events.filter((e) => e.eventType === 'sent')).toHaveLength(1);
    const renders = await base.outboxEvent.findMany({
      where: { workspaceId, type: 'pdf.render', aggregateId: invoiceId },
    });
    expect(renders).toHaveLength(1);
  });
});
