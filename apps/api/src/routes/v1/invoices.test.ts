import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processProviderEvent, recordProviderEvent } from '@wolff/core/payments';
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
          payment_intent: 'pi_test_123',
        }),
      },
    },
  };
  let orderCounter = 0;
  const razorpay = {
    orders: {
      create: async () => ({ id: `order_${++orderCounter}` }),
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

  beforeEach(async () => {
    await base.providerWebhookEvent.deleteMany({
      where: { eventId: { startsWith: 'evt_reconcile_' } },
    });
    await base.payment.deleteMany({ where: { workspaceId: ws.id } });
  });

  afterAll(async () => {
    await base.providerWebhookEvent.deleteMany({
      where: { eventId: { startsWith: 'evt_reconcile_' } },
    });
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
      orderId: 'order_1',
      amount: 118000,
      currency: 'INR',
      keyId: 'rzp_test_123',
    });

    // A pending Payment row is created so the webhook can reconcile.
    const payments = await base.payment.findMany({ where: { workspaceId: ws.id } });
    expect(payments).toHaveLength(1);
    const razorpayPayment = payments[0]!;
    expect(razorpayPayment).toMatchObject({
      status: 'pending',
      provider: 'razorpay',
      providerOrderId: 'order_1',
    });
    expect(Number(razorpayPayment.amount)).toBe(1180);
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

    const payments = await base.payment.findMany({ where: { workspaceId: ws.id } });
    expect(payments).toHaveLength(1);
    const stripePayment = payments[0]!;
    expect(stripePayment).toMatchObject({
      status: 'pending',
      provider: 'stripe',
      stripePaymentIntentId: 'pi_test_123',
    });
    expect(Number(stripePayment.amount)).toBe(1180);
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

  it('rejects payment links without an Idempotency-Key header', async () => {
    const res = await request(app)
      .post(`/v1/invoices/${invoiceId}/payment-links`)
      .set('Authorization', auth(ws.key))
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.details['Idempotency-Key']).toBeDefined();
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

  it('marks the invoice paid when the Razorpay webhook for the order is processed', async () => {
    const link = await as(ws.key).post(`/v1/invoices/${invoiceId}/payment-links`).send({});
    expect(link.status).toBe(200);
    const orderId = link.body.data.orderId as string;

    const event = {
      event: 'order.paid',
      payload: {
        order: { entity: { id: orderId } },
        payment: {
          entity: {
            id: 'pay_reconcile_1',
            order_id: orderId,
            amount: 118000,
            currency: 'INR',
            method: 'upi',
          },
        },
      },
    };
    const { id } = await recordProviderEvent(db, {
      provider: 'razorpay',
      workspaceId: ws.id,
      eventId: `evt_reconcile_${orderId}`,
      type: event.event,
      payload: event,
      outbox: false,
    });

    expect(await processProviderEvent(db, id)).toBe('processed');

    const invoice = await base.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.status).toBe('paid');
    expect(Number(invoice.amountPaid)).toBe(1180);
    expect(Number(invoice.amountDue)).toBe(0);
    const payment = await base.payment.findFirstOrThrow({ where: { invoiceId } });
    expect(payment.status).toBe('completed');
    expect(payment.providerPaymentId).toBe('pay_reconcile_1');
  });
});
