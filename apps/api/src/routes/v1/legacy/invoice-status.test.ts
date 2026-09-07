import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEGACY_KEY_SCOPES } from '@wolff/contracts';
import { request } from '../../../testing/request';
import { TEST_DATABASE_URL, issueKey, testApp, testDb } from '../../../testing/harness';

/**
 * PATCH /v1/invoices/:id may move the status, but the status must agree with
 * the money: 'paid' or 'partial' only when the recorded payments say so, and
 * never 'voided' while a completed payment is still on the invoice.
 */
describe.skipIf(!TEST_DATABASE_URL)('PATCH /v1/invoices/:id status and money (Postgres)', () => {
  const { base, db } = testDb();
  const app = testApp(db, { email: { send: async () => {} } });
  let workspaceId = '';
  let clientId = '';
  let key = '';
  let n = 0;

  beforeAll(async () => {
    const ws = await base.workspace.create({
      data: {
        name: 'Invoice status',
        slug: `invoice-status-${Date.now()}`,
        clients: { create: [{ name: 'Payer', email: 'payer@status.test' }] },
      },
      include: { clients: true },
    });
    workspaceId = ws.id;
    clientId = ws.clients[0]!.id;
    key = (
      await issueKey(base, ws.id, { scopes: [...LEGACY_KEY_SCOPES], rateLimitPerMin: 100_000 })
    ).key;
  });

  afterAll(async () => {
    await base.payment.deleteMany({ where: { workspaceId } });
    await base.workspace.deleteMany({ where: { id: workspaceId } });
    await base.$disconnect();
  });

  const invoice = async (data: { status: string; amountPaid?: number; payment?: boolean }) => {
    const amountPaid = data.amountPaid ?? 0;
    const created = await base.invoice.create({
      data: {
        workspaceId,
        clientId,
        invoiceNumber: `ST-${++n}`,
        status: data.status,
        dueDate: new Date(Date.now() + 86_400_000),
        subtotal: 100,
        total: 100,
        amountPaid,
        amountDue: 100 - amountPaid,
        ...(data.payment && {
          payments: {
            create: {
              workspaceId,
              amount: amountPaid,
              currency: 'usd',
              paymentMethod: 'card',
              status: 'completed',
              provider: 'stripe',
            },
          },
        }),
      },
    });
    return created.id;
  };

  const patch = (id: string, body: object) =>
    request(app).patch(`/v1/invoices/${id}`).set('Authorization', `Bearer ${key}`).send(body);

  it.each(['paid', 'partial'])('refuses to mark an unpaid invoice %s', async (status) => {
    const id = await invoice({ status: 'sent' });
    const res = await patch(id, { status });
    expect(res.status).toBe(400);
    const after = await base.invoice.findUniqueOrThrow({ where: { id } });
    expect(after.status).toBe('sent');
    expect(after.paidAt).toBeNull();
  });

  it('marks paid an invoice whose payments cover the total', async () => {
    const id = await invoice({ status: 'sent', amountPaid: 100, payment: true });
    const res = await patch(id, { status: 'paid' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('paid');
  });

  it('marks partial an invoice with a part payment', async () => {
    const id = await invoice({ status: 'sent', amountPaid: 40, payment: true });
    const res = await patch(id, { status: 'partial' });
    expect(res.status).toBe(200);
  });

  it('refuses to void an invoice that still has a completed payment', async () => {
    const id = await invoice({ status: 'paid', amountPaid: 100, payment: true });
    const res = await patch(id, { status: 'voided' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/refund/i);
    expect((await base.invoice.findUniqueOrThrow({ where: { id } })).status).toBe('paid');
  });

  it('still voids an unpaid invoice', async () => {
    const id = await invoice({ status: 'sent' });
    const res = await patch(id, { status: 'voided' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('voided');
  });
});
