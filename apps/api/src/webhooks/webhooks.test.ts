import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import Stripe from 'stripe';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { TEST_DATABASE_URL, testConfig, testDb } from '../testing/harness';
import { verifyRazorpaySignature } from './razorpay';

const PLATFORM = 'whsec_platform_secret';
const CONNECT = 'whsec_connect_secret';
const stripe = new Stripe('sk_test_unused');

describe('verifyRazorpaySignature', () => {
  const body = '{"event":"payment.captured"}';
  const secret = 'rzp_webhook_secret';
  const signature = createHmac('sha256', secret).update(body).digest('hex');

  it('accepts the HMAC-SHA256 of the raw body under the workspace secret', () => {
    expect(verifyRazorpaySignature(body, signature, secret)).toBe(true);
    expect(verifyRazorpaySignature(Buffer.from(body), signature, secret)).toBe(true);
  });

  it.each([
    ['another secret', body, signature, 'other'],
    ['a changed body', `${body} `, signature, secret],
    ['a truncated signature', body, signature.slice(0, 32), secret],
    ['a signature that is not hex', body, 'z'.repeat(64), secret],
    ['no signature', body, undefined, secret],
    ['an empty secret', body, signature, ''],
  ])('rejects %s', (_name, b, s, k) => {
    expect(verifyRazorpaySignature(b, s, k)).toBe(false);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('inbound Stripe webhooks (Postgres)', () => {
  const { base, db } = testDb();
  const run = randomUUID().replace(/-/g, '');
  const recorded: string[] = [];
  const app = createApp({
    db,
    config: testConfig({
      STRIPE_WEBHOOK_SECRET: PLATFORM,
      STRIPE_CONNECT_WEBHOOK_SECRET: CONNECT,
    }),
    onOutboxEvents: (ids) => void recorded.push(...ids),
  });
  let n = 0;

  const event = (type = 'payment_intent.succeeded', extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      id: `evt_${run}_${++n}`,
      object: 'event',
      type,
      data: { object: { id: `pi_${run}_${n}`, latest_charge: null } },
      ...extra,
    });
  const post = (
    path: string,
    payload: string,
    options: { secret?: string; timestamp?: number; signature?: string | null } = {}
  ) => {
    const req = request(app).post(path).set('Content-Type', 'application/json');
    const signature =
      options.signature === undefined
        ? stripe.webhooks.generateTestHeaderString({
            payload,
            secret: options.secret ?? PLATFORM,
            timestamp: options.timestamp,
          })
        : options.signature;
    return (signature === null ? req : req.set('Stripe-Signature', signature)).send(payload);
  };
  const rowsFor = (payload: string) =>
    base.providerWebhookEvent.findMany({ where: { eventId: JSON.parse(payload).id } });

  beforeAll(() => {
    recorded.length = 0;
  });

  afterEach(async () => {
    const events = await base.providerWebhookEvent.findMany({
      where: { eventId: { startsWith: `evt_${run}` } },
      select: { id: true },
    });
    await base.outboxEvent.deleteMany({ where: { aggregateId: { in: events.map((e) => e.id) } } });
    await base.providerWebhookEvent.deleteMany({ where: { id: { in: events.map((e) => e.id) } } });
  });

  afterAll(async () => {
    await base.$disconnect();
  });

  it('stores a signed event with its reconcile job and acknowledges it', async () => {
    const payload = event();

    const res = await post('/webhooks/stripe', payload);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    const [row] = await rowsFor(payload);
    expect(row).toMatchObject({
      provider: 'stripe',
      type: 'payment_intent.succeeded',
      status: 'received',
    });
    expect(row!.payload).toEqual(JSON.parse(payload));
    const jobs = await base.outboxEvent.findMany({ where: { aggregateId: row!.id } });
    expect(jobs.map((j) => [j.type, j.status])).toEqual([['payment.reconcile', 'pending']]);
    expect(recorded).toContain(jobs[0]!.id);
  });

  it('acknowledges a redelivery without storing or queueing it again', async () => {
    const payload = event();

    await post('/webhooks/stripe', payload);
    const again = await post('/webhooks/stripe', payload);

    expect(again.status).toBe(200);
    expect(again.body).toEqual({ received: true, duplicate: true });
    const rows = await rowsFor(payload);
    expect(rows).toHaveLength(1);
    expect(await base.outboxEvent.count({ where: { aggregateId: rows[0]!.id } })).toBe(1);
  });

  it.each([
    ['no signature header', { signature: null }],
    ['a signature made with another secret', { secret: 'whsec_wrong' }],
    ['a signature older than 5 minutes', { timestamp: Math.floor(Date.now() / 1000) - 301 }],
    ['a malformed signature header', { signature: 't=abc,v1=def' }],
  ])('refuses an event with %s and stores nothing', async (_name, options) => {
    const payload = event();

    const res = await post('/webhooks/stripe', payload, options);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'validation_error', message: 'Invalid webhook signature' },
    });
    expect(await rowsFor(payload)).toEqual([]);
  });

  it('verifies the bytes it received: a body changed after signing is refused', async () => {
    const payload = event();
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: PLATFORM });

    const res = await post(
      '/webhooks/stripe',
      payload.replace('"object":"event"', '"object": "event"'),
      {
        signature,
      }
    );

    expect(res.status).toBe(400);
  });

  it('keeps the two endpoints on their own secrets', async () => {
    const onPlatform = event();
    const onConnect = event('account.updated', { account: 'acct_1' });

    expect((await post('/webhooks/stripe', onPlatform, { secret: CONNECT })).status).toBe(400);
    expect((await post('/webhooks/stripe/connect', onConnect, { secret: PLATFORM })).status).toBe(
      400
    );
    const accepted = await post('/webhooks/stripe/connect', onConnect, { secret: CONNECT });

    expect(accepted.status).toBe(200);
    expect(await rowsFor(onConnect)).toHaveLength(1);
  });

  it('answers 501 when the endpoint has no secret configured', async () => {
    const bare = createApp({ db, config: testConfig() });
    const payload = event();

    const res = await request(bare)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set(
        'Stripe-Signature',
        stripe.webhooks.generateTestHeaderString({ payload, secret: PLATFORM })
      )
      .send(payload);

    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('not_configured');
  });

  it('answers 500, so the provider retries, when the event cannot be stored', async () => {
    const broken = createApp({
      db: {
        $unscoped: {
          $transaction: async () => {
            throw new Error('connection terminated');
          },
        },
      } as never,
      config: testConfig({ STRIPE_WEBHOOK_SECRET: PLATFORM }),
    });
    const payload = event();

    const res = await request(broken)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set(
        'Stripe-Signature',
        stripe.webhooks.generateTestHeaderString({ payload, secret: PLATFORM })
      )
      .send(payload);

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('connection terminated');
  });

  it('has the Razorpay route in place, answering 501 until a workspace can store a secret', async () => {
    const res = await request(app)
      .post(`/webhooks/razorpay/${randomUUID()}`)
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', 'abc')
      .send('{}');

    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('not_configured');
  });
});

describe.skipIf(!TEST_DATABASE_URL)('inbound Razorpay webhooks (Postgres)', () => {
  const { base, db } = testDb();
  const run = randomUUID().replace(/-/g, '');
  const recorded: string[] = [];
  const app = createApp({
    db,
    config: testConfig(),
    onOutboxEvents: (ids) => void recorded.push(...ids),
  });
  let workspaceId = '';
  const secret = 'rzp_webhook_secret';
  let n = 0;

  const payload = (event = 'payment.captured') =>
    JSON.stringify({
      event,
      payload: {
        payment: {
          entity: {
            id: `pay_${run}_${++n}`,
            order_id: `order_${run}_${n}`,
            amount: 25_000,
            method: 'upi',
          },
        },
      },
    });

  const post = (
    body: string,
    options: { signature?: string | null; eventId?: string | null } = {}
  ) => {
    const req = request(app)
      .post(`/webhooks/razorpay/${workspaceId}`)
      .set('Content-Type', 'application/json');
    if (options.eventId !== null)
      req.set('X-Razorpay-Event-Id', options.eventId ?? `evt_${run}_${++n}`);
    if (options.signature !== null) {
      req.set(
        'X-Razorpay-Signature',
        options.signature ?? createHmac('sha256', secret).update(body).digest('hex')
      );
    }
    return req.send(body);
  };

  beforeAll(async () => {
    recorded.length = 0;
    const workspace = await base.workspace.create({
      data: {
        name: 'Razorpay Webhooks',
        slug: `razorpay-webhooks-${run}`,
        paymentSettings: { create: { razorpayWebhookSecretEnc: secret } },
      },
    });
    workspaceId = workspace.id;
  });

  afterEach(async () => {
    const events = await base.providerWebhookEvent.findMany({
      where: { eventId: { startsWith: `evt_${run}` } },
      select: { id: true },
    });
    await base.outboxEvent.deleteMany({ where: { aggregateId: { in: events.map((e) => e.id) } } });
    await base.providerWebhookEvent.deleteMany({ where: { id: { in: events.map((e) => e.id) } } });
  });

  afterAll(async () => {
    await base.paymentSettings.deleteMany({ where: { workspaceId } });
    await base.workspace.deleteMany({ where: { id: workspaceId } });
    await base.$disconnect();
  });

  it('stores a signed event with its reconcile job and acknowledges it', async () => {
    const body = payload();

    const res = await post(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    const rows = await base.providerWebhookEvent.findMany({
      where: { provider: 'razorpay', eventId: { startsWith: `evt_${run}` } },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'razorpay',
      type: 'payment.captured',
      status: 'received',
    });
    const jobs = await base.outboxEvent.findMany({ where: { aggregateId: rows[0]!.id } });
    expect(jobs.map((j) => [j.type, j.status])).toEqual([['payment.reconcile', 'pending']]);
    expect(recorded).toContain(jobs[0]!.id);
  });

  it('acknowledges a redelivery without storing or queueing it again', async () => {
    const body = payload();

    await post(body, { eventId: 'evt_redrive_1' });
    const again = await post(body, { eventId: 'evt_redrive_1' });

    expect(again.status).toBe(200);
    expect(again.body).toEqual({ received: true, duplicate: true });
    const rows = await base.providerWebhookEvent.findMany({
      where: { provider: 'razorpay', eventId: 'evt_redrive_1' },
    });
    expect(rows).toHaveLength(1);
    expect(await base.outboxEvent.count({ where: { aggregateId: rows[0]!.id } })).toBe(1);
  });

  it.each([
    ['no signature header', { signature: null }],
    [
      'a signature made with another secret',
      { signature: createHmac('sha256', 'other').update(payload()).digest('hex') },
    ],
    [
      'a changed body',
      { signature: createHmac('sha256', secret).update(payload()).digest('hex') },
      true,
    ],
  ])('refuses an event with %s and stores nothing', async (_name, options, mutateBody = false) => {
    const body = payload();
    const sendBody = mutateBody ? `${body} ` : body;

    const res = await post(sendBody, options as { signature?: string | null });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'validation_error', message: expect.any(String) },
    });
    const rows = await base.providerWebhookEvent.findMany({
      where: { provider: 'razorpay', eventId: { startsWith: `evt_${run}` } },
    });
    expect(rows).toHaveLength(0);
  });
});
