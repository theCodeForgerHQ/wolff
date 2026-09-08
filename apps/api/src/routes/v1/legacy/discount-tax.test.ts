import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEGACY_KEY_SCOPES } from '@wolff/contracts';
import { request } from '../../../testing/request';
import { TEST_DATABASE_URL, issueKey, testApp, testDb } from '../../../testing/harness';

/**
 * Replacing the lines of a discounted quote or invoice prices it the way
 * the dashboard does: the discount comes off before tax, so the tax is on
 * the discounted amount. 1000 at 18% with 10% off is 900 + 162 = 1062.
 */
describe.skipIf(!TEST_DATABASE_URL)('PATCH line items on a discounted document (Postgres)', () => {
  const { base, db } = testDb();
  const app = testApp(db, { email: { send: async () => {} } });
  let workspaceId = '';
  let clientId = '';
  let key = '';

  beforeAll(async () => {
    const ws = await base.workspace.create({
      data: {
        name: 'Discount tax',
        slug: `discount-tax-${Date.now()}`,
        clients: { create: [{ name: 'Buyer', email: 'buyer@discount.test' }] },
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
    await base.workspace.deleteMany({ where: { id: workspaceId } });
    await base.$disconnect();
  });

  const lines = [{ name: 'Work', quantity: 1, rate: 1000, taxRate: 18 }];
  const discount = { discountType: 'percentage', discountValue: 10 };

  it('taxes the discounted amount of a quote', async () => {
    const quote = await base.quote.create({
      data: { workspaceId, clientId, quoteNumber: 'D-1', title: 'Q', status: 'draft', ...discount },
    });
    const res = await request(app)
      .patch(`/v1/quotes/${quote.id}`)
      .set('Authorization', `Bearer ${key}`)
      .send({ lineItems: lines });
    expect(res.status).toBe(200);
    const saved = await base.quote.findUniqueOrThrow({ where: { id: quote.id } });
    expect(Number(saved.discountAmount)).toBe(100);
    expect(Number(saved.taxTotal)).toBe(162);
    expect(Number(saved.total)).toBe(1062);
  });

  it('taxes the discounted amount of an invoice', async () => {
    const invoice = await base.invoice.create({
      data: {
        workspaceId,
        clientId,
        invoiceNumber: 'D-INV-1',
        title: 'I',
        status: 'draft',
        dueDate: new Date(Date.now() + 86_400_000),
        ...discount,
      },
    });
    const res = await request(app)
      .patch(`/v1/invoices/${invoice.id}`)
      .set('Authorization', `Bearer ${key}`)
      .send({ lineItems: lines });
    expect(res.status).toBe(200);
    const saved = await base.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(Number(saved.taxTotal)).toBe(162);
    expect(Number(saved.total)).toBe(1062);
    expect(Number(saved.amountDue)).toBe(1062);
  });
});
