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
});
