import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrisma, withTenantGuard } from '@wolff/database';
import { CoreError } from '../errors';
import { createDraftQuote, type DraftQuoteInput } from './draft';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('createDraftQuote', () => {
  const base = createPrisma(url!);
  const db = withTenantGuard(base, { mode: 'throw' });
  const ids: string[] = [];
  let a: { ws: string; user: string; client: string; card: string; deal: string };
  let b: { ws: string; client: string; card: string; deal: string };
  let otherClientOfA: string;

  async function workspace(label: string) {
    const run = randomUUID();
    const user = await base.user.create({ data: { email: `${run}@draft.test`, name: label } });
    const ws = await base.workspace.create({
      data: { name: label, slug: `draft-${run}`, ownerId: user.id },
    });
    ids.push(ws.id);
    const client = await base.client.create({
      data: { workspaceId: ws.id, name: `${label} client`, email: `${run}@client.test` },
    });
    const card = await base.rateCard.create({
      data: { workspaceId: ws.id, name: 'UX audit', rate: 40000, hsnSac: '998314' },
    });
    const pipeline = await base.pipeline.create({ data: { workspaceId: ws.id, name: 'Sales' } });
    const stage = await base.stage.create({
      data: { workspaceId: ws.id, pipelineId: pipeline.id, name: 'New', position: 0 },
    });
    const deal = await base.deal.create({
      data: {
        workspaceId: ws.id,
        pipelineId: pipeline.id,
        stageId: stage.id,
        clientId: client.id,
        title: 'Deal',
        value: 1,
      },
    });
    return { ws: ws.id, user: user.id, client: client.id, card: card.id, deal: deal.id };
  }

  const input = (over: Partial<DraftQuoteInput> = {}): DraftQuoteInput => ({
    clientId: a.client,
    title: 'Website redesign',
    currency: 'INR',
    lineItems: [
      {
        name: 'UX audit',
        quantity: 1,
        rate: 40000,
        hsnSac: '998314',
        gstRate: 18,
        source: 'rate_card',
        sourceRef: a.card,
      },
      { name: 'Copywriting', quantity: 2, rate: 5000, source: 'new' },
    ],
    assumptions: ['Two rounds of revisions'],
    ...over,
  });

  beforeAll(async () => {
    a = await workspace('Draft A');
    b = await workspace('Draft B');
    otherClientOfA = (
      await base.client.create({
        data: { workspaceId: a.ws, name: 'Other client', email: `${randomUUID()}@client.test` },
      })
    ).id;
  });

  afterAll(async () => {
    await base.outboxEvent.deleteMany({ where: { workspaceId: { in: ids } } });
    await base.deal.deleteMany({ where: { workspaceId: { in: ids } } });
    await base.quote.deleteMany({ where: { workspaceId: { in: ids } } });
    await base.workspace.deleteMany({ where: { id: { in: ids } } });
    await base.$disconnect();
  });

  it('creates a draft with its lines, totals, deal link and an index event', async () => {
    const created = await createDraftQuote(
      { db, workspaceId: a.ws, actorId: a.user },
      input({ dealId: a.deal })
    );
    const quote = await base.quote.findUniqueOrThrow({
      where: { id: created.quoteId },
      include: { lineItems: { orderBy: { sortOrder: 'asc' } }, events: true },
    });
    expect(quote).toMatchObject({ workspaceId: a.ws, status: 'draft', currency: 'INR' });
    expect(quote.quoteNumber).toBe(created.quoteNumber);
    expect(Number(quote.subtotal)).toBe(50000);
    expect(quote.lineItems.map((l) => [l.name, Number(l.amount), l.rateCardId])).toEqual([
      ['UX audit', 40000, a.card],
      ['Copywriting', 10000, null],
    ]);
    expect(quote.internalNotes).toContain('Two rounds of revisions');
    expect(quote.events.map((e) => e.eventType)).toEqual(['created']);
    const deal = await base.deal.findUniqueOrThrow({ where: { id: a.deal } });
    expect(deal.quoteId).toBe(created.quoteId);
    const event = await base.outboxEvent.findFirst({
      where: { workspaceId: a.ws, type: 'ai.index', aggregateId: created.quoteId },
    });
    expect(event).not.toBeNull();
  });

  it.each([
    ['a client of another workspace', () => input({ clientId: b.client }), 'not_found'],
    ['a deal of another workspace', () => input({ dealId: b.deal }), 'not_found'],
    [
      'a deal of another client of the workspace',
      () => input({ clientId: otherClientOfA, dealId: a.deal }),
      'validation_error',
    ],
    [
      'a rate card of another workspace',
      () =>
        input({
          lineItems: [{ name: 'x', quantity: 1, rate: 1, source: 'rate_card', sourceRef: b.card }],
        }),
      'validation_error',
    ],
    ['no lines', () => input({ lineItems: [] }), 'validation_error'],
    [
      'a zero quantity',
      () => input({ lineItems: [{ name: 'x', quantity: 0, rate: 1, source: 'new' }] }),
      'validation_error',
    ],
    [
      'a negative rate',
      () => input({ lineItems: [{ name: 'x', quantity: 1, rate: -5, source: 'new' }] }),
      'validation_error',
    ],
    [
      'a NaN rate',
      () => input({ lineItems: [{ name: 'x', quantity: 1, rate: Number.NaN, source: 'new' }] }),
      'validation_error',
    ],
  ])('refuses %s and writes nothing', async (_label, make, code) => {
    const before = await base.quote.count({ where: { workspaceId: a.ws } });
    const error = await createDraftQuote({ db, workspaceId: a.ws }, make()).catch((e) => e);
    expect(error).toBeInstanceOf(CoreError);
    expect(error.code).toBe(code);
    expect(await base.quote.count({ where: { workspaceId: a.ws } })).toBe(before);
  });
});
