import { request } from '../../testing/request';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  TEST_DATABASE_URL,
  createTestWorkspace,
  issueKey,
  testApp,
  testDb,
  type TestWorkspace,
} from '../../testing/harness';

describe.skipIf(!TEST_DATABASE_URL)('/v1/public widget routes', () => {
  const { base, db } = testDb();
  const orderRequests: { amount: number; currency: string }[] = [];
  const app = testApp(db, {
    paymentClients: {
      stripe: {
        checkout: {
          sessions: {
            create: async () => ({
              id: 'cs_public_1',
              url: 'https://checkout.stripe.com/pay/cs_public_1',
              payment_intent: 'pi_public_1',
            }),
          },
        },
      } as never,
      razorpay: () =>
        ({
          orders: {
            create: async (request: { amount: number; currency: string }) => {
              orderRequests.push(request);
              return { id: `order_public_${orderRequests.length}` };
            },
          },
        }) as never,
    },
  });
  let a: TestWorkspace;
  let publishableKey: string;

  beforeAll(async () => {
    a = await createTestWorkspace(base, 'Public API A', []);
    const issued = await issueKey(base, a.id, {
      kind: 'publishable',
      prefix: 'wolff_pk_',
      scopes: ['lead:create', 'invoice:pay'],
      allowedOrigins: ['https://client.example.com'],
    });
    publishableKey = issued.key;
  });

  afterEach(async () => {
    await base.payment.deleteMany({ where: { workspaceId: a.id } });
    await base.invoice.deleteMany({ where: { workspaceId: a.id } });
    await base.client.deleteMany({ where: { workspaceId: a.id } });
    await base.paymentSettings.deleteMany({ where: { workspaceId: a.id } });
    await base.lead.deleteMany({ where: { workspaceId: a.id } });
    await base.idempotencyKey.deleteMany({ where: { workspaceId: a.id } });
  });

  afterAll(async () => {
    await base.workspace.deleteMany({ where: { id: a.id } });
    await base.$disconnect();
  });

  it('creates a lead with a valid publishable key and allowed origin', async () => {
    const res = await request(app)
      .post('/v1/public/leads')
      .set('X-Publishable-Key', publishableKey)
      .set('Origin', 'https://client.example.com')
      .send({ name: 'Ada', email: 'ada@example.com' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ data: { message: 'Lead submitted.' } });

    const lead = await base.lead.findFirst({ where: { workspaceId: a.id } });
    expect(lead).not.toBeNull();
    expect(lead!.name).toBe('Ada');
  });

  it('rejects a request from a disallowed origin', async () => {
    const res = await request(app)
      .post('/v1/public/leads')
      .set('X-Publishable-Key', publishableKey)
      .set('Origin', 'https://evil.example.com')
      .send({ name: 'Ada', email: 'ada@example.com' });

    expect(res.status).toBe(401);
  });

  it('answers the CORS preflight only for an origin some publishable key allows', async () => {
    const preflight = (origin: string) =>
      request(app)
        .options('/v1/public/leads')
        .set('Origin', origin)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type,x-publishable-key');

    const allowed = await preflight('https://client.example.com');
    const other = await preflight('https://evil.example.com');

    expect(allowed.headers['access-control-allow-origin']).toBe('https://client.example.com');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('stops answering the preflight for an origin once its key is revoked', async () => {
    const issued = await issueKey(base, a.id, {
      kind: 'publishable',
      prefix: 'wolff_pk_',
      scopes: ['lead:create'],
      allowedOrigins: ['https://revoked.example.com'],
    });
    await base.apiKey.update({ where: { id: issued.id }, data: { revokedAt: new Date() } });

    const res = await request(app)
      .options('/v1/public/leads')
      .set('Origin', 'https://revoked.example.com')
      .set('Access-Control-Request-Method', 'POST');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects a missing publishable key', async () => {
    const res = await request(app)
      .post('/v1/public/leads')
      .set('Origin', 'https://client.example.com')
      .send({ name: 'Ada', email: 'ada@example.com' });

    expect(res.status).toBe(401);
  });

  it('rejects a secret key on public routes', async () => {
    const secret = await issueKey(base, a.id, { kind: 'secret', scopes: ['leads:write'] });
    const res = await request(app)
      .post('/v1/public/leads')
      .set('X-Publishable-Key', secret.key)
      .set('Origin', 'https://client.example.com')
      .send({ name: 'Ada', email: 'ada@example.com' });

    expect(res.status).toBe(401);
  });
  describe('origin check', () => {
    const lead = { name: 'Ada', email: 'ada@example.com' };

    it('refuses every origin when the key lists none', async () => {
      const open = await issueKey(base, a.id, {
        kind: 'publishable',
        prefix: 'wolff_pk_',
        scopes: ['lead:create'],
        allowedOrigins: [],
      });

      const res = await request(app)
        .post('/v1/public/leads')
        .set('X-Publishable-Key', open.key)
        .set('Origin', 'https://anyone.example.net')
        .send(lead);

      expect(res.status).toBe(401);
    });

    it('does not accept a Referer in place of the Origin header', async () => {
      const wildcard = await issueKey(base, a.id, {
        kind: 'publishable',
        prefix: 'wolff_pk_',
        scopes: ['lead:create'],
        allowedOrigins: ['*.client.example.com'],
      });

      // Any page can end its own URL with ".client.example.com".
      const res = await request(app)
        .post('/v1/public/leads')
        .set('X-Publishable-Key', wildcard.key)
        .set('Referer', 'https://evil.example.net/?x=.client.example.com')
        .send(lead);

      expect(res.status).toBe(401);
    });

    it.each([
      'https://client.example.com.evil.net',
      'http://client.example.com',
      'https://client.example.com:8443',
      'https://www.client.example.com',
    ])('refuses %s, which is not exactly an allowed origin', async (origin) => {
      const res = await request(app)
        .post('/v1/public/leads')
        .set('X-Publishable-Key', publishableKey)
        .set('Origin', origin)
        .send(lead);

      expect(res.status).toBe(401);
    });

    it('does not let a refused origin read the response', async () => {
      const res = await request(app)
        .post('/v1/public/leads')
        .set('X-Publishable-Key', publishableKey)
        .set('Origin', 'https://evil.example.com')
        .send(lead);

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
  describe('scopes', () => {
    const keyWith = (scopes: string[]) =>
      issueKey(base, a.id, {
        kind: 'publishable',
        prefix: 'wolff_pk_',
        scopes,
        allowedOrigins: ['https://client.example.com'],
      });

    it('needs lead:create to submit a lead', async () => {
      const payOnly = await keyWith(['invoice:pay']);

      const res = await request(app)
        .post('/v1/public/leads')
        .set('X-Publishable-Key', payOnly.key)
        .set('Origin', 'https://client.example.com')
        .send({ name: 'Ada', email: 'ada@example.com' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('insufficient_scope');
      expect(await base.lead.count({ where: { workspaceId: a.id } })).toBe(0);
    });

    it('needs invoice:pay to start a payment', async () => {
      const leadsOnly = await keyWith(['lead:create']);

      const res = await request(app)
        .post('/v1/public/invoices/some-token/pay')
        .set('X-Publishable-Key', leadsOnly.key)
        .set('Origin', 'https://client.example.com')
        .send({});

      expect(res.status).toBe(403);
    });
  });
  describe('lead submissions', () => {
    const post = (body: Record<string, unknown>) =>
      request(app)
        .post('/v1/public/leads')
        .set('X-Publishable-Key', publishableKey)
        .set('Origin', 'https://client.example.com')
        .send(body);

    it.each([
      ['ownerId', { ownerId: '00000000-0000-4000-8000-000000000000' }],
      ['status', { status: 'won' }],
      ['score', { score: 100 }],
      ['source', { source: 'manual' }],
    ])('refuses a %s chosen by the visitor', async (_field, extra) => {
      const res = await post({ name: 'Ada', email: 'ada@example.com', ...extra });

      expect(res.status).toBe(400);
      expect(await base.lead.count({ where: { workspaceId: a.id } })).toBe(0);
    });

    it('records the lead as coming from the widget', async () => {
      await post({ name: 'Ada', email: 'ada@example.com', company: 'Lovelace Ltd' });

      const lead = await base.lead.findFirstOrThrow({ where: { workspaceId: a.id } });
      expect(lead).toMatchObject({ source: 'widget', status: 'new', ownerId: null, score: null });
    });

    it('answers a repeated email the same way, without saying the lead exists', async () => {
      const first = await post({ name: 'Ada', email: 'ada@example.com' });
      const second = await post({ name: 'Someone', email: 'ada@example.com' });

      expect(second.status).toBe(first.status);
      expect(second.body).toEqual(first.body);
      expect(await base.lead.count({ where: { workspaceId: a.id } })).toBe(1);
    });
  });
  describe('invoice payment by portal token', () => {
    const pay = (token: string, key = publishableKey) =>
      request(app)
        .post(`/v1/public/invoices/${token}/pay`)
        .set('X-Publishable-Key', key)
        .set('Origin', 'https://client.example.com')
        .send({});

    const invoiceIn = async (workspaceId: string, data: Record<string, unknown> = {}) => {
      const client = await base.client.create({
        data: { workspaceId, name: 'Payer', email: `payer-${Math.random()}@example.test` },
      });
      await base.paymentSettings.upsert({
        where: { workspaceId },
        create: {
          workspaceId,
          activeProviders: ['razorpay'],
          razorpayKeyId: 'rzp_test_public',
          razorpayKeySecretEnc: 'rzp_secret_plaintext',
          defaultProviderByCurrency: { INR: 'razorpay', '*': 'stripe' },
        },
        update: {},
      });
      return base.invoice.create({
        data: {
          workspaceId,
          clientId: client.id,
          invoiceNumber: `PUB-${Math.random().toString(36).slice(2, 8)}`,
          status: 'sent',
          dueDate: new Date(Date.now() + 86_400_000),
          total: 1180,
          amountPaid: 180,
          amountDue: 1000,
          currency: 'INR',
          ...data,
        } as never,
      });
    };

    it('starts a payment for what is due, found by the emailed token', async () => {
      const invoice = await invoiceIn(a.id);

      const res = await pay(invoice.accessToken);

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ provider: 'razorpay', amount: 100_000 });
      const payment = await base.payment.findFirstOrThrow({ where: { invoiceId: invoice.id } });
      expect(payment).toMatchObject({ status: 'pending', provider: 'razorpay' });
      expect(Number(payment.amount)).toBe(1000);
    });

    it('does not accept the invoice id in place of the token', async () => {
      const invoice = await invoiceIn(a.id);

      expect((await pay(invoice.id)).status).toBe(404);
    });

    it('does not accept an expired token', async () => {
      const invoice = await invoiceIn(a.id, { accessTokenExpiresAt: new Date(Date.now() - 1000) });

      expect((await pay(invoice.accessToken)).status).toBe(404);
    });

    it('does not pay an invoice of another workspace with this key', async () => {
      const other = await createTestWorkspace(base, 'Public API other', []);
      try {
        const invoice = await invoiceIn(other.id);

        expect((await pay(invoice.accessToken)).status).toBe(404);
      } finally {
        await base.invoice.deleteMany({ where: { workspaceId: other.id } });
        await base.client.deleteMany({ where: { workspaceId: other.id } });
        await base.paymentSettings.deleteMany({ where: { workspaceId: other.id } });
        await base.workspace.deleteMany({ where: { id: other.id } });
      }
    });

    it('has no route that reads a quote (not by id, not by token)', async () => {
      const client = await base.client.create({
        data: { workspaceId: a.id, name: 'Q', email: `q-${Math.random()}@example.test` },
      });
      const quote = await base.quote.create({
        data: { workspaceId: a.id, clientId: client.id, quoteNumber: 'Q-PUB-1', title: 'Secret' },
      });
      try {
        for (const handle of [quote.id, quote.accessToken]) {
          const res = await request(app)
            .get(`/v1/public/quotes/${handle}`)
            .set('X-Publishable-Key', publishableKey)
            .set('Origin', 'https://client.example.com');

          // No public route matches; the request falls through to the
          // secret-key API, which refuses a publishable key.
          expect([401, 404]).toContain(res.status);
          expect(JSON.stringify(res.body)).not.toContain('Secret');
        }
      } finally {
        await base.quote.deleteMany({ where: { id: quote.id } });
      }
    });
  });
});
