import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createPrisma, withTenantGuard } from '@wolff/database';
import type { CoreContext } from '../context';
import { ensureDefaultPipeline } from '../crm/pipelines';
import { createQuoteFromDeal } from '.';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('createQuoteFromDeal (Postgres)', () => {
  const base = createPrisma(url);
  const db = withTenantGuard(base, { mode: 'throw' });
  const run = randomUUID().slice(0, 8);
  const workspaces: string[] = [];

  async function workspace(): Promise<CoreContext & { clientId: string }> {
    const ws = await base.workspace.create({
      data: {
        name: 'Quote from deal',
        slug: `quote-from-deal-${run}-${workspaces.length}`,
        clients: {
          create: { name: 'Meera', email: `meera-${run}-${workspaces.length}@example.test` },
        },
      },
      include: { clients: true },
    });
    workspaces.push(ws.id);
    return { db, workspaceId: ws.id, clientId: ws.clients[0]!.id };
  }

  async function deal(
    ctx: CoreContext & { clientId: string },
    data: { withClient?: boolean; quoteId?: string; deletedAt?: Date } = {}
  ) {
    const { pipelineId, stageIds } = await ensureDefaultPipeline(db, ctx.workspaceId);
    const created = await base.deal.create({
      data: {
        workspaceId: ctx.workspaceId,
        pipelineId,
        stageId: stageIds[0]!,
        title: 'Website',
        value: 5_000,
        currency: 'EUR',
        clientId: data.withClient === false ? null : ctx.clientId,
        quoteId: data.quoteId,
        deletedAt: data.deletedAt,
      },
    });
    return created.id;
  }

  afterAll(async () => {
    await base.deal.deleteMany({ where: { workspaceId: { in: workspaces } } });
    await base.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await base.$disconnect();
  });

  it('creates a numbered draft quote in the deal currency and links it to the deal', async () => {
    const ctx = await workspace();
    const dealId = await deal(ctx);

    const before = Date.now();
    const first = await createQuoteFromDeal(ctx, { dealId });
    const second = await createQuoteFromDeal(ctx, { dealId: await deal(ctx), title: 'Custom' });

    expect(first.quoteNumber).not.toBe(second.quoteNumber);
    expect(first.quoteNumber).toMatch(/^QT/);
    const quote = await base.quote.findUniqueOrThrow({ where: { id: first.quoteId } });
    expect(quote).toMatchObject({
      workspaceId: ctx.workspaceId,
      clientId: ctx.clientId,
      quoteNumber: first.quoteNumber,
      title: 'Quote for Website',
      status: 'draft',
      currency: 'EUR',
    });
    const days = (quote.expirationDate!.getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
    expect((await base.deal.findUniqueOrThrow({ where: { id: dealId } })).quoteId).toBe(
      first.quoteId
    );
    expect((await base.quote.findUniqueOrThrow({ where: { id: second.quoteId } })).title).toBe(
      'Custom'
    );
  });

  it('uses the expiration date given', async () => {
    const ctx = await workspace();
    const expirationDate = new Date('2027-01-15T00:00:00Z');

    const { quoteId } = await createQuoteFromDeal(ctx, { dealId: await deal(ctx), expirationDate });

    const quote = await base.quote.findUniqueOrThrow({ where: { id: quoteId } });
    expect(quote.expirationDate?.toISOString().slice(0, 10)).toBe('2027-01-15');
  });

  it('refuses a deal that already has a quote, and creates no second one', async () => {
    const ctx = await workspace();
    const dealId = await deal(ctx);
    await createQuoteFromDeal(ctx, { dealId });

    await expect(createQuoteFromDeal(ctx, { dealId })).rejects.toMatchObject({ code: 'conflict' });
    expect(await base.quote.count({ where: { workspaceId: ctx.workspaceId } })).toBe(1);
  });

  it('refuses a deal without a client', async () => {
    const ctx = await workspace();
    const dealId = await deal(ctx, { withClient: false });

    await expect(createQuoteFromDeal(ctx, { dealId })).rejects.toMatchObject({
      code: 'business_rule',
    });
    expect(await base.quote.count({ where: { workspaceId: ctx.workspaceId } })).toBe(0);
  });

  it("refuses another workspace's deal and a deleted one", async () => {
    const a = await workspace();
    const b = await workspace();
    const theirs = await deal(b);
    const deleted = await deal(a, { deletedAt: new Date() });

    for (const dealId of [theirs, deleted]) {
      await expect(createQuoteFromDeal(a, { dealId })).rejects.toMatchObject({
        code: 'not_found',
      });
    }
    expect((await base.deal.findUniqueOrThrow({ where: { id: theirs } })).quoteId).toBeNull();
  });
});
