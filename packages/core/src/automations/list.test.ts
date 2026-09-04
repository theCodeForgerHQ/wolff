import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrisma, withTenantGuard } from '@wolff/database';
import type { CoreContext } from '../context';
import { listAutomationRuns, listAutomations } from '.';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('automation lists (Postgres)', () => {
  const base = createPrisma(url);
  const db = withTenantGuard(base, { mode: 'throw' });
  const run = randomUUID().slice(0, 8);
  let ctx: CoreContext;
  let other: CoreContext;
  const names: string[] = [];
  let firstAutomation = '';

  beforeAll(async () => {
    const ws = await base.workspace.create({ data: { name: 'Lists', slug: `auto-list-${run}` } });
    const ws2 = await base.workspace.create({
      data: { name: 'Other', slug: `auto-list-other-${run}` },
    });
    ctx = { db, workspaceId: ws.id };
    other = { db, workspaceId: ws2.id };
    for (let i = 0; i < 3; i++) {
      const a = await base.automation.create({
        data: {
          workspaceId: ws.id,
          name: `A${i}`,
          trigger: i === 2 ? 'deal.stalled' : 'invoice.overdue',
          steps: [{ type: 'wait', days: 1 }],
          isActive: i !== 1,
        },
      });
      names.unshift(a.name);
      if (i === 0) firstAutomation = a.id;
      await base.automationRun.create({
        data: {
          workspaceId: ws.id,
          automationId: a.id,
          subjectId: randomUUID(),
          status: i === 0 ? 'done' : 'running',
        },
      });
    }
    await base.automation.create({
      data: { workspaceId: ws2.id, name: 'Theirs', trigger: 'invoice.overdue', steps: [] },
    });
  });

  afterAll(async () => {
    for (const id of [ctx.workspaceId, other.workspaceId]) {
      await base.automationRun.deleteMany({ where: { workspaceId: id } });
      await base.automation.deleteMany({ where: { workspaceId: id } });
    }
    await base.workspace.deleteMany({
      where: { id: { in: [ctx.workspaceId, other.workspaceId] } },
    });
    await base.$disconnect();
  });

  it('pages automations by the limit asked for, newest first', async () => {
    const first = await listAutomations(ctx, { limit: 2 });

    expect(first.data.map((a) => a.name)).toEqual(names.slice(0, 2));
    expect(first.meta).toMatchObject({ hasMore: true, total: 3 });

    const second = await listAutomations(ctx, { limit: 2, cursor: first.meta.nextCursor! });
    expect(second.data.map((a) => a.name)).toEqual(names.slice(2));
    expect(second.meta).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it('filters automations by trigger and active flag, within the workspace', async () => {
    const byTrigger = await listAutomations(ctx, {
      limit: 10,
      filters: { trigger: 'deal.stalled' },
    });
    const inactive = await listAutomations(ctx, { limit: 10, filters: { isActive: false } });

    expect(byTrigger.data.map((a) => a.name)).toEqual(['A2']);
    expect(inactive.data.map((a) => a.name)).toEqual(['A1']);
    expect((await listAutomations(other, { limit: 10 })).data.map((a) => a.name)).toEqual([
      'Theirs',
    ]);
  });

  it('pages runs by the limit asked for, and filters them', async () => {
    const first = await listAutomationRuns(ctx, { limit: 2 });

    expect(first.data).toHaveLength(2);
    expect(first.meta).toMatchObject({ hasMore: true, total: 3 });
    expect(first.data[0]!.automation).toMatchObject({ name: 'A2' });
    const second = await listAutomationRuns(ctx, { limit: 2, cursor: first.meta.nextCursor! });
    expect(second.data).toHaveLength(1);
    expect(second.meta.hasMore).toBe(false);

    const running = await listAutomationRuns(ctx, { limit: 10, filters: { status: 'running' } });
    expect(running.meta.total).toBe(2);
    const ofFirst = await listAutomationRuns(ctx, {
      limit: 10,
      filters: { automationId: firstAutomation },
    });
    expect(ofFirst.data.map((r) => r.status)).toEqual(['done']);
    expect((await listAutomationRuns(other, { limit: 10 })).meta.total).toBe(0);
  });
});
