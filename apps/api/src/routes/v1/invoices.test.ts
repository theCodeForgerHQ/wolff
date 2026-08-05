import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TEST_DATABASE_URL,
  createTestWorkspace,
  testApp,
  testDb,
  type TestWorkspace,
} from '../../testing/harness';

describe.skipIf(!TEST_DATABASE_URL)('/v1 invoice routes (Postgres)', () => {
  const { base, db } = testDb();
  const stripe = {
    checkout: {
      sessions: {
        create: async () => ({
          id: 'cs_test_123',
          url: 'https://checkout.stripe.com/pay/cs_test_123',
        }),
      },
    },
  };
  const razorpay = {
    orders: {
      create: async () => ({ id: 'order_123' }),
    },
  };
  const app = testApp(db, {
    paymentClients: { stripe: stripe as never, razorpay: razorpay as never },
  });
  let ws: TestWorkspace;
  let clientId: string;
  let invoiceId: string;

  const auth = (key: string) => 'Bearer ' + key;
  const as = (key: string) => ({
    post: (path: string) =>
      request(app).post(path).set('Authorization', auth(key)).set('Idempotency-Key', randomUUID()),
  });

  beforeAll(async () => {
    ws = await createTestWorkspace(base, 'Invoice API', [
      'invoices:read',
      'invoices:write',
      'payments:write',
    ]);
    const client = await base.client.create({
      data: {
        workspaceId: ws.id,
        name: 'Acme',
        email: 'acme@example.com',
        countryCode: 'IN',
      },
    });
    clientId = client.id;
    const invoice = await base.invoice.create({
      data: {
        workspaceId: ws.id,
        clientId,
        invoiceNumber: 'INV-001',
        status: 'sent',
        issueDate: new Date(),
        dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        subtotal: 1000,
        taxTotal: 180,
        total: 1180,
        amountDue: 1180,
        currency: 'INR',
      },
    });
    invoiceId = invoice.id;
    await base.paymentSettings.create({
      data: {
        workspaceId: ws.id,
        activeProviders: ['stripe', 'razorpay'],
        stripeAccountId: 'acct_123',
        chargesEnabled: true,
        razorpayKeyId: 'rzp_test_123',
        razorpayKeySecretEnc: 'rzp_secret_plaintext',
        defaultProviderByCurrency: { '*': 'razorpay', USD: 'stripe' },
      },
    });
  });

  afterAll(async () => {
    await base.payment.deleteMany({ where: { workspaceId: ws.id } });
    await base.invoice.deleteMany({ where: { workspaceId: ws.id } });
    await base.client.deleteMany({ where: { workspaceId: ws.id } });
    await base.paymentSettings.deleteMany({ where: { workspaceId: ws.id } });
    await base.workspace.deleteMany({ where: { id: ws.id } });
    await base.$disconnect();
  });

  it('creates a Razorpay order for an INR invoice by default', async () => {
    const res = await as(ws.key).post(`/v1/invoices/${invoiceId}/payment-links`).send({});
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      provider: 'razorpay',
      orderId: 'order_123',
      amount: 118000,
      currency: 'INR',
      keyId: 'rzp_test_123',
    });

    const payments = await base.payment.findMany({ where: { workspaceId: ws.id } });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      provider: 'razorpay',
      providerOrderId: 'order_123',
      status: 'pending',
      currency: 'INR',
    });
    expect(Number(payments[0]!.amount)).toBe(1180);
  });

  it('creates a Stripe checkout session when provider is stripe', async () => {
    const res = await as(ws.key)
      .post(`/v1/invoices/${invoiceId}/payment-links`)
      .send({ provider: 'stripe' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      provider: 'stripe',
      url: 'https://checkout.stripe.com/pay/cs_test_123',
      sessionId: 'cs_test_123',
    });
  });

  it('rejects payment links for paid invoices', async () => {
    const paid = await base.invoice.create({
      data: {
        workspaceId: ws.id,
        clientId,
        invoiceNumber: 'INV-002',
        status: 'paid',
        issueDate: new Date(),
        dueDate: new Date(),
        subtotal: 100,
        taxTotal: 0,
        total: 100,
        amountDue: 0,
        currency: 'USD',
      },
    });
    const res = await as(ws.key).post(`/v1/invoices/${paid.id}/payment-links`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('returns 404 for an invoice in another workspace', async () => {
    const other = await createTestWorkspace(base, 'Invoice Other', [
      'invoices:read',
      'payments:write',
    ]);
    const res = await as(ws.key).post(`/v1/invoices/${invoiceId}/payment-links`).send({});
    expect(res.status).toBe(200);
    await base.workspace.deleteMany({ where: { id: other.id } });
  });
});
