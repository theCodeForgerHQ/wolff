import { randomUUID } from 'node:crypto';
import { request } from '../../testing/request';
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
  // Real Stripe (API 2022-08-01 and later, so the pinned 2026-08-26.dahlia)
  // creates the PaymentIntent when the session is confirmed, so a new
  // session has `payment_intent: null`; stripe-mock fills it in. Tests set
  // the shape they need.
  let sessionIntent: string | null = 'pi_test_123';
  let sessionCounter = 0;
  const stripe = {
    checkout: {
      sessions: {
        create: async () => {
          const id = `cs_test_${++sessionCounter}`;
          return {
            id,
            url: `https://checkout.stripe.com/pay/${id}`,
            payment_intent: sessionIntent,
          };
        },
      },
    },
  };
  let orderCounter = 0;
  const orderRequests: { amount: number }[] = [];
  // Each order is created with the keys of the workspace that owns the
  // invoice; the factory records which keys it was given.
  const razorpayKeys: { keyId: string; keySecret: string }[] = [];
  const razorpay = (keyId: string, keySecret: string) => {
    razorpayKeys.push({ keyId, keySecret });
    return {
      orders: {
        create: async (request: { amount: number }) => {
          orderRequests.push(request);
          return { id: `order_${++orderCounter}` };
        },
      },
    };
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

    // The order is created with the workspace's own Razorpay keys.
    expect(razorpayKeys.at(-1)).toEqual({
      keyId: 'rzp_test_123',
      keySecret: 'rzp_secret_plaintext',
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
    const sessionId = res.body.data.sessionId as string;
    expect(res.body.data).toMatchObject({
      provider: 'stripe',
      url: `https://checkout.stripe.com/pay/${sessionId}`,
    });

    const payments = await base.payment.findMany({ where: { workspaceId: ws.id } });
    expect(payments).toHaveLength(1);
    const stripePayment = payments[0]!;
    expect(stripePayment).toMatchObject({
      status: 'pending',
      provider: 'stripe',
      providerOrderId: sessionId,
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
  it('charges what is still due on a partly paid invoice, not the total', async () => {
    const partly = await base.invoice.create({
      data: {
        workspaceId: ws.id,
        clientId,
        invoiceNumber: `INV-PART-${randomUUID().slice(0, 6)}`,
        status: 'partial',
        issueDate: new Date(),
        dueDate: new Date(Date.now() + 7 * 86_400_000),
        subtotal: 1000,
        taxTotal: 180,
        total: 1180,
        amountPaid: 500,
        amountDue: 680,
        currency: 'INR',
      },
    });

    const res = await as(ws.key).post(`/v1/invoices/${partly.id}/payment-links`).send({});

    expect(res.status).toBe(200);
    expect(res.body.data.amount).toBe(68_000);
    expect(orderRequests.at(-1)!.amount).toBe(68_000);
    const payment = await base.payment.findFirstOrThrow({ where: { invoiceId: partly.id } });
    expect(Number(payment.amount)).toBe(680);
  });

  describe('Stripe Checkout reconciliation', () => {
    const stripeInvoice = () =>
      base.invoice.create({
        data: {
          workspaceId: ws.id,
          clientId,
          invoiceNumber: `INV-CS-${randomUUID().slice(0, 6)}`,
          status: 'sent',
          issueDate: new Date(),
          dueDate: new Date(Date.now() + 7 * 86_400_000),
          total: 1180,
          amountDue: 1180,
          currency: 'USD',
        },
      });
    const deliver = async (type: string, object: Record<string, unknown>) => {
      const event = { id: `evt_reconcile_${randomUUID()}`, type, data: { object } };
      const { id } = await recordProviderEvent(db, {
        provider: 'stripe',
        eventId: event.id,
        type,
        payload: event,
        outbox: false,
      });
      return processProviderEvent(db, id);
    };

    it('opens a session without a payment intent and pays on checkout.session.completed', async () => {
      sessionIntent = null;
      try {
        const invoice = await stripeInvoice();
        const res = await as(ws.key)
          .post(`/v1/invoices/${invoice.id}/payment-links`)
          .send({ provider: 'stripe' });
        expect(res.status).toBe(200);
        const sessionId = res.body.data.sessionId as string;
        const pending = await base.payment.findFirstOrThrow({ where: { invoiceId: invoice.id } });
        expect(pending).toMatchObject({ providerOrderId: sessionId, stripePaymentIntentId: null });

        // The intent's own event can come first; it is not linked yet.
        await deliver('payment_intent.succeeded', { id: 'pi_late_1' });
        await deliver('checkout.session.completed', {
          id: sessionId,
          object: 'checkout.session',
          mode: 'payment',
          payment_status: 'paid',
          payment_intent: 'pi_late_1',
          amount_total: 118_000,
          currency: 'usd',
        });

        const paid = await base.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
        expect(paid.status).toBe('paid');
        expect(Number(paid.amountPaid)).toBe(1180);
        const payment = await base.payment.findFirstOrThrow({ where: { invoiceId: invoice.id } });
        expect(payment).toMatchObject({ status: 'completed', stripePaymentIntentId: 'pi_late_1' });

        // A redelivery, or the intent event arriving after, credits nothing more.
        await deliver('payment_intent.succeeded', { id: 'pi_late_1' });
        expect(
          Number((await base.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).amountPaid)
        ).toBe(1180);
      } finally {
        sessionIntent = 'pi_test_123';
      }
    });

    it('does not credit a completed session that is not paid yet (async methods)', async () => {
      sessionIntent = null;
      try {
        const invoice = await stripeInvoice();
        const res = await as(ws.key)
          .post(`/v1/invoices/${invoice.id}/payment-links`)
          .send({ provider: 'stripe' });

        await deliver('checkout.session.completed', {
          id: res.body.data.sessionId,
          payment_status: 'unpaid',
          payment_intent: 'pi_async_1',
          amount_total: 118_000,
          currency: 'usd',
        });
        expect((await base.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe(
          'sent'
        );

        await deliver('payment_intent.succeeded', { id: 'pi_async_1' });
        expect((await base.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe(
          'paid'
        );
      } finally {
        sessionIntent = 'pi_test_123';
      }
    });

    const openSession = async () => {
      const invoice = await stripeInvoice();
      const res = await as(ws.key)
        .post(`/v1/invoices/${invoice.id}/payment-links`)
        .send({ provider: 'stripe' });
      return { invoice, sessionId: res.body.data.sessionId as string };
    };
    const paymentOf = (invoiceId: string) =>
      base.payment.findFirstOrThrow({ where: { invoiceId } });

    it.each(['checkout.session.expired', 'checkout.session.async_payment_failed'])(
      'marks the pending payment failed on %s',
      async (type) => {
        sessionIntent = null;
        try {
          const { invoice, sessionId } = await openSession();

          await deliver(type, { id: sessionId, object: 'checkout.session' });

          expect((await paymentOf(invoice.id)).status).toBe('failed');
          expect((await base.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe(
            'sent'
          );
        } finally {
          sessionIntent = 'pi_test_123';
        }
      }
    );

    it.each([
      ['amount', { amount_total: 100, currency: 'usd' }],
      ['currency', { amount_total: 118_000, currency: 'eur' }],
      ['missing amount', { currency: 'usd' }],
    ])('does not credit a paid session whose %s differs from the payment', async (_, fields) => {
      sessionIntent = null;
      try {
        const { invoice, sessionId } = await openSession();
        const intentId = `pi_mismatch_${randomUUID().slice(0, 6)}`;

        await deliver('checkout.session.completed', {
          id: sessionId,
          object: 'checkout.session',
          payment_status: 'paid',
          payment_intent: intentId,
          ...fields,
        });
        // Nor later through the intent: the session was never linked to it.
        await deliver('payment_intent.succeeded', { id: intentId });

        const after = await base.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
        expect(after).toMatchObject({ status: 'sent' });
        expect(Number(after.amountPaid)).toBe(0);
        expect(await paymentOf(invoice.id)).toMatchObject({
          status: 'pending',
          stripePaymentIntentId: null,
        });
        const events = await base.invoiceEvent.findMany({ where: { invoiceId: invoice.id } });
        expect(events.map((e) => e.eventType)).toContain('payment_mismatch');
      } finally {
        sessionIntent = 'pi_test_123';
      }
    });

    it('pays on payment_intent.succeeded when the session came with an intent', async () => {
      const invoice = await stripeInvoice();
      await as(ws.key)
        .post(`/v1/invoices/${invoice.id}/payment-links`)
        .send({ provider: 'stripe' });

      await deliver('payment_intent.succeeded', { id: 'pi_test_123' });

      expect((await base.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe(
        'paid'
      );
    });
  });

  it('refuses a Razorpay link, saying why, when the workspace has no Razorpay keys', async () => {
    await base.paymentSettings.update({
      where: { workspaceId: ws.id },
      data: { razorpayKeyId: null, razorpayKeySecretEnc: null },
    });
    try {
      const unpaid = await base.invoice.create({
        data: {
          workspaceId: ws.id,
          clientId,
          invoiceNumber: `INV-NOKEY-${randomUUID().slice(0, 6)}`,
          status: 'sent',
          dueDate: new Date(Date.now() + 7 * 86_400_000),
          total: 100,
          amountDue: 100,
          currency: 'INR',
        },
      });
      const created = razorpayKeys.length;
      const res = await as(ws.key)
        .post(`/v1/invoices/${unpaid.id}/payment-links`)
        .send({ provider: 'razorpay' });

      expect(res.body.error.code).toBe('not_configured');
      expect(res.body.error.message).toMatch(/Razorpay keys are not configured for this workspace/);
      expect(razorpayKeys).toHaveLength(created);
    } finally {
      await base.paymentSettings.update({
        where: { workspaceId: ws.id },
        data: { razorpayKeyId: 'rzp_test_123', razorpayKeySecretEnc: 'rzp_secret_plaintext' },
      });
    }
  });
});
