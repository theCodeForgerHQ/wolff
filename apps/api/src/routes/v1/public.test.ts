import request from 'supertest';
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
  const app = testApp(db);
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
});
