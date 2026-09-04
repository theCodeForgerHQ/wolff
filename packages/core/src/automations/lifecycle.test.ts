import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrisma, withTenantGuard } from '@wolff/database';
import type { CoreContext } from '../context';
import { ensureDefaultPipeline } from '../crm/pipelines';
import {
  createAutomation,
  deleteAutomation,
  getAutomation,
  getAutomationRun,
  listRunningAutomationRuns,
  scanAutomationTriggers,
  tickAutomationRun,
  updateAutomation,
} from '.';

const url = process.env.TEST_DATABASE_URL;
const DAY = 86_400_000;

describe.skipIf(!url)('automations: CRUD, trigger scan and step ticks (Postgres)', () => {
  const base = createPrisma(url);
  const db = withTenantGuard(base, { mode: 'throw' });
  const run = randomUUID().slice(0, 8);
  let ctx: CoreContext;
  let other: CoreContext;
  let clientId = '';
  const now = new Date('2026-10-08T10:00:00Z');
  const dispatched: [string, number, number][] = [];
  const dispatch = async (id: string, step: number, delay: number) => {
    dispatched.push([id, step, delay]);
  };

  beforeAll(async () => {
    const ws = await base.workspace.create({
      data: {
        name: 'Lifecycle',
        slug: `auto-life-${run}`,
        clients: { create: { name: 'Nila', email: `nila-${run}@example.test` } },
      },
      include: { clients: true },
    });
    const ws2 = await base.workspace.create({
      data: { name: 'Other', slug: `auto-life-o-${run}` },
    });
    ctx = { db, workspaceId: ws.id };
    other = { db, workspaceId: ws2.id };
    clientId = ws.clients[0]!.id;
  });

  afterAll(async () => {
    for (const id of [ctx.workspaceId, other.workspaceId]) {
      await base.outboxEvent.deleteMany({ where: { workspaceId: id } });
      await base.scheduledEmail.deleteMany({ where: { workspaceId: id } });
      await base.automationRun.deleteMany({ where: { workspaceId: id } });
      await base.automation.deleteMany({ where: { workspaceId: id } });
      await base.dealActivity.deleteMany({ where: { workspaceId: id } });
      await base.deal.deleteMany({ where: { workspaceId: id } });
      await base.emailTemplate.deleteMany({ where: { workspaceId: id } });
      await base.invoice.deleteMany({ where: { workspaceId: id } });
      await base.quote.deleteMany({ where: { workspaceId: id } });
    }
    await base.workspace.deleteMany({
      where: { id: { in: [ctx.workspaceId, other.workspaceId] } },
    });
    await base.$disconnect();
  });

  const automation = (trigger: string, steps: unknown[], isActive = true) =>
    base.automation.create({
      data: {
        workspaceId: ctx.workspaceId,
        name: trigger,
        trigger,
        steps: steps as never,
        isActive,
      },
    });
  const runOf = (automationId: string, subjectId: string = randomUUID(), extra: object = {}) =>
    base.automationRun.create({
      data: { workspaceId: ctx.workspaceId, automationId, subjectId, status: 'running', ...extra },
    });
  const tick = (id: string, at = now) => tickAutomationRun(ctx, id, { dispatch, now: at });
  const lastLog = (r: { log: unknown } | null) => (r?.log as { message: string }[]).at(-1)?.message;

  describe('CRUD', () => {
    it('creates, updates, reads and deletes within the workspace only', async () => {
      const created = await createAutomation(ctx, {
        name: 'Nudge',
        trigger: 'invoice.overdue',
        steps: [{ type: 'wait', days: 2 }],
      });
      expect(created).toMatchObject({ name: 'Nudge', isActive: true });

      expect(await updateAutomation(other, created.id, { name: 'Stolen' })).toBeNull();
      expect(await getAutomation(other, created.id)).toBeNull();
      expect(await deleteAutomation(other, created.id)).toBeNull();

      const updated = await updateAutomation(ctx, created.id, { isActive: false, name: 'Quiet' });
      expect(updated).toMatchObject({ name: 'Quiet', isActive: false, trigger: 'invoice.overdue' });

      expect((await deleteAutomation(ctx, created.id))?.id).toBe(created.id);
      expect(await getAutomation(ctx, created.id)).toBeNull();
    });

    it("refuses an update whose steps name another workspace's template", async () => {
      const theirs = await base.emailTemplate.create({
        data: {
          workspaceId: other.workspaceId,
          name: 'T',
          subject: 'S',
          body: 'B',
          type: 'custom',
        },
      });
      const created = await createAutomation(ctx, {
        name: 'X',
        trigger: 'invoice.overdue',
        steps: [{ type: 'wait', days: 1 }],
      });

      await expect(
        updateAutomation(ctx, created.id, {
          steps: [{ type: 'send_email', templateId: theirs.id }],
        })
      ).rejects.toMatchObject({ code: 'validation_error' });
    });
  });

  describe('trigger scan', () => {
    it('starts one run per overdue invoice, stale sent quote and stalled deal, once', async () => {
      // Only this test's automations (the CRUD tests left an active one).
      await base.automation.deleteMany({ where: { workspaceId: ctx.workspaceId } });
      const overdue = await automation('invoice.overdue', [{ type: 'wait', days: 1 }]);
      const noReply = await automation('quote.sent_no_response', [{ type: 'wait', days: 1 }]);
      const stalled = await automation('deal.stalled', [{ type: 'wait', days: 1 }]);
      const inactive = await automation('invoice.overdue', [{ type: 'wait', days: 1 }], false);

      const invoice = await base.invoice.create({
        data: {
          workspaceId: ctx.workspaceId,
          clientId,
          invoiceNumber: `LC-${run}`,
          status: 'overdue',
          total: 10,
          subtotal: 10,
          amountDue: 10,
          dueDate: new Date('2026-09-01'),
        },
      });
      const notOverdue = await base.invoice.create({
        data: {
          workspaceId: ctx.workspaceId,
          clientId,
          invoiceNumber: `LC2-${run}`,
          status: 'sent',
          total: 10,
          subtotal: 10,
          amountDue: 10,
          dueDate: new Date('2026-12-01'),
        },
      });
      const old = new Date(now.getTime() - 10 * DAY);
      const staleQuote = await base.quote.create({
        data: {
          workspaceId: ctx.workspaceId,
          clientId,
          quoteNumber: `LQ-${run}`,
          status: 'sent',
          total: 1,
          subtotal: 1,
        },
      });
      await base.$executeRaw`UPDATE quotes SET updated_at = ${old} WHERE id = ${staleQuote.id}`;
      const freshQuote = await base.quote.create({
        data: {
          workspaceId: ctx.workspaceId,
          clientId,
          quoteNumber: `LQ2-${run}`,
          status: 'sent',
          total: 1,
          subtotal: 1,
        },
      });
      // One day old: inside the 7-day window, so not stale yet.
      const recent = new Date(now.getTime() - DAY);
      await base.$executeRaw`UPDATE quotes SET updated_at = ${recent} WHERE id = ${freshQuote.id}`;
      const { pipelineId, stageIds } = await ensureDefaultPipeline(db, ctx.workspaceId);
      const deal = await base.deal.create({
        data: {
          workspaceId: ctx.workspaceId,
          pipelineId,
          stageId: stageIds[0]!,
          title: 'Quiet',
          value: 1,
        },
      });
      await base.$executeRaw`UPDATE deals SET updated_at = ${old} WHERE id = ${deal.id}`;

      await scanAutomationTriggers(db, { now });
      await scanAutomationTriggers(db, { now });

      const runs = await base.automationRun.findMany({ where: { workspaceId: ctx.workspaceId } });
      const pairs = runs.map((r) => `${r.automationId}:${r.subjectId}`).sort();
      expect(pairs).toEqual(
        [
          `${overdue.id}:${invoice.id}`,
          `${noReply.id}:${staleQuote.id}`,
          `${stalled.id}:${deal.id}`,
        ].sort()
      );
      expect(runs.every((r) => r.status === 'running')).toBe(true);
      expect(pairs.join()).not.toContain(inactive.id);
      expect(pairs.join()).not.toContain(notOverdue.id);
      expect(pairs.join()).not.toContain(freshQuote.id);
      expect(await listRunningAutomationRuns(db, 10_000)).toEqual(
        expect.arrayContaining(runs.map((r) => r.id))
      );

      await base.automationRun.deleteMany({ where: { workspaceId: ctx.workspaceId } });
      await base.automation.deleteMany({ where: { workspaceId: ctx.workspaceId } });
    });
  });

  describe('ticks', () => {
    it('finishes a run past its last step, and leaves a finished or foreign run alone', async () => {
      const a = await automation('invoice.overdue', [{ type: 'ai_draft_email' }]);
      const r = await runOf(a.id);

      const first = await tick(r.id);
      expect(first).toMatchObject({ currentStep: 1, status: 'running' });
      expect(lastLog(first)).toMatch(/AI draft step skipped/);
      expect(await tick(r.id)).toMatchObject({ status: 'done' });
      expect(await tick(r.id)).toMatchObject({ status: 'done', currentStep: 1 });
      expect(await tickAutomationRun(other, r.id, { dispatch, now })).toBeNull();
    });

    it('starts a wait, schedules its end, and continues only once the days have passed', async () => {
      const a = await automation('invoice.overdue', [{ type: 'wait', days: 2 }]);
      const r = await runOf(a.id);

      const started = await tick(r.id);
      expect(started?.waitingSince?.toISOString()).toBe(now.toISOString());
      expect(dispatched).toContainEqual([r.id, 0, 2 * DAY]);

      expect(await tick(r.id, new Date(now.getTime() + DAY))).toMatchObject({ currentStep: 0 });
      const done = await tick(r.id, new Date(now.getTime() + 2 * DAY));
      expect(done).toMatchObject({ currentStep: 1, waitingSince: null });
      expect(lastLog(done)).toBe('Waited 2 day(s).');
    });

    it('skips a send_email step whose template is gone or whose subject has no email', async () => {
      const template = await base.emailTemplate.create({
        data: { workspaceId: ctx.workspaceId, name: 'T', subject: 'S', body: 'B', type: 'custom' },
      });
      const a = await automation('invoice.overdue', [
        { type: 'send_email', templateId: template.id },
      ]);
      const gone = await automation('invoice.overdue', [
        { type: 'send_email', templateId: randomUUID() },
      ]);

      // The subject id names no invoice, so there is no recipient.
      expect(lastLog(await tick((await runOf(a.id)).id))).toBe('No recipient email; skipped.');
      expect(lastLog(await tick((await runOf(gone.id)).id))).toBe(
        'Email template not found; skipped.'
      );
      expect(await base.scheduledEmail.count({ where: { workspaceId: ctx.workspaceId } })).toBe(0);
    });

    it('emails the client of a stale quote and of a stalled deal', async () => {
      const template = await base.emailTemplate.create({
        data: { workspaceId: ctx.workspaceId, name: 'Q', subject: 'Hi', body: 'B', type: 'custom' },
      });
      const quote = await base.quote.create({
        data: {
          workspaceId: ctx.workspaceId,
          clientId,
          quoteNumber: `LQ3-${run}`,
          status: 'sent',
          total: 1,
          subtotal: 1,
        },
      });
      const { pipelineId, stageIds } = await ensureDefaultPipeline(db, ctx.workspaceId);
      const deal = await base.deal.create({
        data: {
          workspaceId: ctx.workspaceId,
          pipelineId,
          stageId: stageIds[0]!,
          title: 'D',
          value: 1,
          clientId,
        },
      });
      const step = [{ type: 'send_email', templateId: template.id }];
      const forQuote = await automation('quote.sent_no_response', step);
      const forDeal = await automation('deal.stalled', step);

      await tick((await runOf(forQuote.id, quote.id)).id);
      await tick((await runOf(forDeal.id, deal.id)).id);

      const emails = await base.scheduledEmail.findMany({
        where: { workspaceId: ctx.workspaceId, templateId: template.id },
      });
      expect(emails.map((e) => [e.entityType, e.entityId, e.recipientEmail]).sort()).toEqual(
        [
          ['deal', deal.id, `nila-${run}@example.test`],
          ['quote', quote.id, `nila-${run}@example.test`],
        ].sort()
      );
    });

    it('skips a move_deal step when the deal is gone', async () => {
      const { stageIds } = await ensureDefaultPipeline(db, ctx.workspaceId);
      const a = await automation('deal.stalled', [{ type: 'move_deal', stageId: stageIds[1] }]);

      const r = await tick((await runOf(a.id)).id);

      expect(r).toMatchObject({ currentStep: 1 });
      expect(lastLog(r)).toBe('Deal not found; skipped.');
    });

    it('reads a run with its automation, only in its workspace', async () => {
      const a = await automation('invoice.overdue', [{ type: 'wait', days: 1 }]);
      const r = await runOf(a.id);

      expect(await getAutomationRun(ctx, r.id)).toMatchObject({
        id: r.id,
        automation: { name: 'invoice.overdue', trigger: 'invoice.overdue' },
      });
      expect(await getAutomationRun(other, r.id)).toBeNull();
    });
  });
});
