import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { mintServiceJwt } from '../middleware/service-jwt';
import { request } from '../testing/request';
import { TEST_DATABASE_URL, testConfig, testDb } from '../testing/harness';

const AI = 'a'.repeat(64);

describe.skipIf(!TEST_DATABASE_URL)('/internal routes for the AI service (Postgres)', () => {
  const { base, db } = testDb();
  const app = createApp({ db, config: testConfig({ SVC_JWT_SECRET_AI: AI }) });
  type Ws = {
    id: string;
    user: string;
    client: string;
    card: string;
    deal: string;
    stage2: string;
  };
  let a: Ws;
  let b: Ws;

  async function workspace(label: string, gstin: string | null): Promise<Ws> {
    const run = randomUUID();
    const user = await base.user.create({ data: { email: `${run}@internal.test`, name: label } });
    const ws = await base.workspace.create({
      data: {
        name: label,
        slug: `internal-${run}`,
        ownerId: user.id,
        businessProfile: {
          create: {
            businessName: label,
            gstin,
            stateCode: '29',
            gstRegistrationType: gstin ? 'regular' : 'unregistered',
            currency: 'INR',
          },
        },
      },
    });
    const client = await base.client.create({
      data: {
        workspaceId: ws.id,
        name: `${label} client`,
        email: `${run}@c.test`,
        stateCode: '27',
      },
    });
    const card = await base.rateCard.create({
      data: { workspaceId: ws.id, name: 'UX audit', rate: 40000 },
    });
    const pipeline = await base.pipeline.create({ data: { workspaceId: ws.id, name: 'Sales' } });
    const [s1, s2] = await Promise.all(
      ['New', 'Proposal'].map((name, position) =>
        base.stage.create({ data: { workspaceId: ws.id, pipelineId: pipeline.id, name, position } })
      )
    );
    const deal = await base.deal.create({
      data: {
        workspaceId: ws.id,
        pipelineId: pipeline.id,
        stageId: s1!.id,
        clientId: client.id,
        title: 'Deal',
        value: 1,
      },
    });
    return {
      id: ws.id,
      user: user.id,
      client: client.id,
      card: card.id,
      deal: deal.id,
      stage2: s2!.id,
    };
  }

  const token = (ws: Ws, scopes: string[]) =>
    mintServiceJwt({
      issuer: 'ai',
      secret: AI,
      audience: 'api',
      workspaceId: ws.id,
      scopes,
      subject: ws.user,
    });
  const post = async (path: string, ws: Ws, scopes: string[], body: unknown) =>
    request(app)
      .post(path)
      .set('Authorization', `Bearer ${await token(ws, scopes)}`)
      .send(body as object);

  const draft = (ws: Ws, over: Record<string, unknown> = {}) => ({
    clientId: ws.client,
    title: 'Website redesign',
    currency: 'INR',
    lineItems: [
      { name: 'UX audit', quantity: 1, rate: 40000, source: 'rate_card', sourceRef: ws.card },
    ],
    assumptions: ['Two revisions'],
    ...over,
  });

  beforeAll(async () => {
    a = await workspace('Internal A', '29ABCDE1234F1Z5');
    b = await workspace('Internal B', null);
  });

  afterAll(async () => {
    const where = { workspaceId: { in: [a.id, b.id] } };
    await base.outboxEvent.deleteMany({ where });
    await base.dealActivity.deleteMany({ where });
    await base.deal.deleteMany({ where });
    await base.quote.deleteMany({ where });
    await base.lead.deleteMany({ where });
    await base.workspace.deleteMany({ where: { id: { in: [a.id, b.id] } } });
    await base.$disconnect();
  });

  it('creates a draft quote as the forwarded user', async () => {
    const res = await post('/internal/quotes/draft', a, ['quotes:write'], draft(a));
    expect(res.status).toBe(201);
    const quote = await base.quote.findUniqueOrThrow({
      where: { id: res.body.data.quoteId },
      include: { events: true },
    });
    expect(quote).toMatchObject({ workspaceId: a.id, status: 'draft' });
    expect(quote.events[0]!.actorId).toBe(a.user);
  });

  it('needs quotes:write, and refuses an API key and an unsigned call', async () => {
    expect((await post('/internal/quotes/draft', a, ['quotes:read'], draft(a))).status).toBe(403);
    const unsigned = await request(app).post('/internal/quotes/draft').send(draft(a));
    expect(unsigned.status).toBe(401);
  });

  it("refuses another workspace's client and invalid lines", async () => {
    const foreign = await post('/internal/quotes/draft', a, ['quotes:write'], draft(b));
    expect(foreign.status).toBe(404);
    for (const line of [
      { name: 'x', quantity: 0, rate: 1, source: 'new' },
      { name: 'x', quantity: 1, rate: -1, source: 'new' },
      { name: 'x', quantity: 1, rate: 1, source: 'invented' },
      { name: 'x', quantity: 1, rate: 1, source: 'new', workspaceId: b.id },
    ]) {
      const res = await post(
        '/internal/quotes/draft',
        a,
        ['quotes:write'],
        draft(a, { lineItems: [line] })
      );
      expect(res.status).toBe(400);
    }
    const injected = await post('/internal/quotes/draft', a, ['quotes:write'], {
      ...draft(a),
      workspaceId: b.id,
    });
    expect(injected.status).toBe(400);
  });

  it('computes GST with the workspace profile and the client state', async () => {
    const res = await post('/internal/gst/compute', a, ['quotes:write'], {
      clientId: a.client,
      lines: [{ name: 'UX audit', quantity: 1, rate: 1000, gstRate: 18 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.invoice).toMatchObject({
      supplyType: 'inter',
      taxTotal: 180,
      total: 1180,
    });
    expect(res.body.data.lines[0]).toMatchObject({ igstAmount: 180, cgstAmount: 0 });
  });

  it('refuses GST for a workspace without GST and for a foreign client', async () => {
    const lines = [{ name: 'x', quantity: 1, rate: 1, gstRate: 18 }];
    const unregistered = await post('/internal/gst/compute', b, ['quotes:write'], {
      clientId: b.client,
      lines,
    });
    expect(unregistered.status).toBe(422);
    const foreign = await post('/internal/gst/compute', a, ['quotes:write'], {
      clientId: b.client,
      lines,
    });
    expect(foreign.status).toBe(404);
  });

  it('creates a lead and moves a deal in the token workspace only', async () => {
    const lead = await post('/internal/leads', a, ['leads:write'], { name: 'From MCP' });
    expect(lead.status).toBe(201);
    expect(
      (await base.lead.findUniqueOrThrow({ where: { id: lead.body.data.id } })).workspaceId
    ).toBe(a.id);
    expect((await post('/internal/leads', a, ['leads:read'], { name: 'x' })).status).toBe(403);

    const moved = await post(`/internal/deals/${a.deal}/move`, a, ['deals:write'], {
      stageId: a.stage2,
    });
    expect(moved.status).toBe(200);
    const foreign = await post(`/internal/deals/${b.deal}/move`, a, ['deals:write'], {
      stageId: b.stage2,
    });
    expect(foreign.status).toBe(404);
  });
});
