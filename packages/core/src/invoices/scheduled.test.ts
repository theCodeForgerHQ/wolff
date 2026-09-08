import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPrisma, withTenantGuard } from '@wolff/database';
import type { CoreContext } from '../context';
import { findDueRecurringInvoices, generateRecurringInvoice } from './recurring';
import { markOverdueInvoices } from './overdue';
import { scanInvoiceReminders } from './reminders';

const url = process.env.TEST_DATABASE_URL;
// 1 Oct 2026, 10:00 in India.
const NOW = new Date('2026-10-01T04:30:00Z');
const day = (date: string) => new Date(`${date}T00:00:00.000Z`);

describe.skipIf(!url)('scheduled invoice work (Postgres)', () => {
  const base = createPrisma(url);
  const db = withTenantGuard(base, { mode: 'throw' });
  const run = randomUUID();
  let ctx: CoreContext;
  let other: CoreContext;
  let clientId = '';
  let n = 0;

  const invoice = (data: Record<string, unknown>) =>
    base.invoice.create({
      data: {
        workspaceId: ctx.workspaceId,
        clientId,
        invoiceNumber: `T-${run.slice(0, 6)}-${++n}`,
        status: 'sent',
        issueDate: day('2026-09-01'),
        dueDate: day('2026-10-01'),
        total: 100,
        amountDue: 100,
        ...data,
      } as never,
    });
  const parent = (data: Record<string, unknown> = {}) =>
    invoice({
      isRecurring: true,
      recurringInterval: 'monthly',
      nextRecurringDate: day('2026-10-01'),
      title: 'Retainer',
      subtotal: 100,
      lineItems: { create: [{ name: 'Retainer', quantity: 1, rate: 100, amount: 100 }] },
      ...data,
    });
  const children = (parentInvoiceId: string) =>
    base.invoice.findMany({ where: { parentInvoiceId }, include: { lineItems: true } });

  beforeAll(async () => {
    const [a, b] = await Promise.all(
      ['a', 'b'].map((name) =>
        base.workspace.create({
          data: {
            name: `Scheduled ${name}`,
            slug: `scheduled-${name}-${run}`,
            clients: { create: { name: 'Client', email: `client-${name}-${run}@example.test` } },
          },
          include: { clients: true },
        })
      )
    );
    ctx = { db, workspaceId: a!.id };
    other = { db, workspaceId: b!.id };
    clientId = a!.clients[0]!.id;
  });

  afterEach(async () => {
    const where = { workspaceId: ctx.workspaceId };
    await base.outboxEvent.deleteMany({ where });
    await base.scheduledEmail.deleteMany({ where });
    await base.invoiceEvent.deleteMany({ where: { invoice: where } });
    await base.invoice.updateMany({ where, data: { parentInvoiceId: null } });
    await base.invoice.deleteMany({ where });
    await base.numberSequence.deleteMany({ where });
  });

  afterAll(async () => {
    await base.workspace.deleteMany({
      where: { id: { in: [ctx.workspaceId, other.workspaceId] } },
    });
    await base.$disconnect();
  });

  describe('recurring invoices', () => {
    it('finds parents that are due today in India, with the period they owe', async () => {
      const due = await parent();
      await parent({ nextRecurringDate: day('2026-10-02') });
      await parent({ isRecurring: false });

      const found = (await findDueRecurringInvoices(db, NOW)).filter(
        (f) => f.workspaceId === ctx.workspaceId
      );

      expect(found).toEqual([
        { parentInvoiceId: due.id, workspaceId: ctx.workspaceId, periodKey: '2026-10' },
      ]);
    });

    it('generates a draft copy, numbers it, and moves the parent to the next period', async () => {
      const p = await parent();

      const result = await generateRecurringInvoice(ctx, p.id, '2026-10', NOW);

      expect(result.outcome).toBe('created');
      const [child] = await children(p.id);
      expect(child).toMatchObject({
        status: 'draft',
        recurringPeriodKey: '2026-10',
        title: 'Retainer',
        isRecurring: false,
      });
      expect(child!.invoiceNumber).toBe('INV-0001');
      expect(Number(child!.total)).toBe(100);
      expect(Number(child!.amountDue)).toBe(100);
      expect(child!.issueDate).toEqual(day('2026-10-01'));
      expect(child!.dueDate).toEqual(day('2026-10-31'));
      expect(child!.lineItems.map((l) => l.name)).toEqual(['Retainer']);
      expect(child!.accessToken).toMatch(/^[0-9a-f]{64}$/);
      const after = await base.invoice.findUniqueOrThrow({ where: { id: p.id } });
      expect(after.nextRecurringDate).toEqual(day('2026-11-01'));
      const events = await base.outboxEvent.findMany({ where: { aggregateId: child!.id } });
      expect(events.map((e) => e.type)).toEqual(['invoice.created']);
    });

    it('keeps the billing day when the run is late', async () => {
      // Due on the 1st, generated on the 5th: the next one is still the 1st.
      const p = await parent();

      await generateRecurringInvoice(ctx, p.id, '2026-10', new Date('2026-10-05T04:30:00Z'));

      const after = await base.invoice.findUniqueOrThrow({ where: { id: p.id } });
      expect(after.nextRecurringDate).toEqual(day('2026-11-01'));
    });

    it('catches up a series that fell behind with one invoice, on its billing day', async () => {
      const p = await parent({ nextRecurringDate: day('2026-08-01') });

      const result = await generateRecurringInvoice(
        ctx,
        p.id,
        '2026-08',
        new Date('2026-10-05T04:30:00Z')
      );

      expect(result.outcome).toBe('created');
      expect(await children(p.id)).toHaveLength(1);
      const after = await base.invoice.findUniqueOrThrow({ where: { id: p.id } });
      expect(after.nextRecurringDate).toEqual(day('2026-11-01'));
    });

    it('produces one invoice per parent and period when the job runs twice', async () => {
      const p = await parent();

      const first = await generateRecurringInvoice(ctx, p.id, '2026-10', NOW);
      const second = await generateRecurringInvoice(ctx, p.id, '2026-10', NOW);

      expect([first.outcome, second.outcome]).toEqual(['created', 'skipped']);
      expect(await children(p.id)).toHaveLength(1);
    });

    it('produces one invoice when two runs for the same period race', async () => {
      const p = await parent();

      const outcomes = await Promise.all([
        generateRecurringInvoice(ctx, p.id, '2026-10', NOW),
        generateRecurringInvoice(ctx, p.id, '2026-10', NOW),
      ]);

      expect(outcomes.map((o) => o.outcome).sort()).toEqual(['created', 'skipped']);
      expect(await children(p.id)).toHaveLength(1);
      // The run that lost used no invoice number.
      const sequence = await base.numberSequence.findFirstOrThrow({
        where: { workspaceId: ctx.workspaceId, type: 'invoice' },
      });
      expect(sequence.currentValue).toBe(1);
    });

    it('still produces one invoice when the parent is put back into the same period', async () => {
      const p = await parent();
      await generateRecurringInvoice(ctx, p.id, '2026-10', NOW);
      // Saving the recurring settings again can set the next date back.
      await base.invoice.update({
        where: { id: p.id },
        data: { nextRecurringDate: day('2026-10-20') },
      });

      const again = await generateRecurringInvoice(ctx, p.id, '2026-10', NOW);

      expect(again.outcome).toBe('skipped');
      expect(await children(p.id)).toHaveLength(1);
    });

    it('cannot store a second invoice for the same parent and period', async () => {
      const p = await parent();
      await generateRecurringInvoice(ctx, p.id, '2026-10', NOW);

      await expect(
        invoice({ parentInvoiceId: p.id, recurringPeriodKey: '2026-10' })
      ).rejects.toMatchObject({ code: 'P2002' });
      // Another period, or an invoice without a parent, is not affected.
      await expect(
        invoice({ parentInvoiceId: p.id, recurringPeriodKey: '2026-11' })
      ).resolves.toBeTruthy();
    });

    it('marks an auto-send copy as sent', async () => {
      const p = await parent({ recurringAutoSend: true });

      await generateRecurringInvoice(ctx, p.id, '2026-10', NOW);

      const [child] = await children(p.id);
      expect(child!.status).toBe('sent');
      expect(child!.sentAt).not.toBeNull();
    });

    it('requests the PDF of an auto-sent copy only', async () => {
      const sent = await parent({ recurringAutoSend: true });
      const kept = await parent();

      await generateRecurringInvoice(ctx, sent.id, '2026-10', NOW);
      await generateRecurringInvoice(ctx, kept.id, '2026-10', NOW);

      const pdfFor = async (parentId: string) => {
        const [child] = await children(parentId);
        return base.outboxEvent.findMany({ where: { type: 'pdf.render', aggregateId: child!.id } });
      };
      const [request] = await pdfFor(sent.id);
      expect(request?.payload).toMatchObject({ documentType: 'invoice' });
      expect(await pdfFor(kept.id)).toHaveLength(0);
    });

    it('stops a series whose end date has passed, without generating', async () => {
      const p = await parent({ recurringEndDate: day('2026-09-30') });

      expect((await generateRecurringInvoice(ctx, p.id, '2026-10', NOW)).outcome).toBe('ended');

      expect(await children(p.id)).toHaveLength(0);
      const after = await base.invoice.findUniqueOrThrow({ where: { id: p.id } });
      expect(after).toMatchObject({ isRecurring: false, nextRecurringDate: null });
    });

    it('ends the series when the next occurrence would fall after the end date', async () => {
      const p = await parent({ recurringEndDate: day('2026-10-15') });

      expect((await generateRecurringInvoice(ctx, p.id, '2026-10', NOW)).outcome).toBe('created');

      const after = await base.invoice.findUniqueOrThrow({ where: { id: p.id } });
      expect(after).toMatchObject({ isRecurring: false, nextRecurringDate: null });
    });

    it("does not generate from another workspace's parent", async () => {
      const p = await parent();

      expect((await generateRecurringInvoice(other, p.id, '2026-10', NOW)).outcome).toBe(
        'not_found'
      );
      expect(await children(p.id)).toHaveLength(0);
    });
  });

  describe('overdue', () => {
    it('moves sent and viewed invoices past their due date to overdue, once', async () => {
      const late = await invoice({ dueDate: day('2026-09-30') });
      const viewed = await invoice({ dueDate: day('2026-09-01'), status: 'viewed' });
      const dueToday = await invoice({ dueDate: day('2026-10-01') });
      const draft = await invoice({ dueDate: day('2026-09-01'), status: 'draft' });
      const paid = await invoice({ dueDate: day('2026-09-01'), status: 'paid' });
      const partial = await invoice({ dueDate: day('2026-09-01'), status: 'partial' });

      await markOverdueInvoices(db, NOW);
      await markOverdueInvoices(db, NOW);

      const status = async (id: string) =>
        (await base.invoice.findUniqueOrThrow({ where: { id } })).status;
      expect(await status(late.id)).toBe('overdue');
      expect(await status(viewed.id)).toBe('overdue');
      expect(await status(dueToday.id)).toBe('sent');
      expect(await status(draft.id)).toBe('draft');
      expect(await status(paid.id)).toBe('paid');
      expect(await status(partial.id)).toBe('partial');
      expect(
        await base.invoiceEvent.count({ where: { invoiceId: late.id, eventType: 'overdue' } })
      ).toBe(1);
      expect(
        await base.outboxEvent.count({ where: { aggregateId: late.id, type: 'invoice.overdue' } })
      ).toBe(1);
    });
  });

  describe('reminders', () => {
    const scan = async () =>
      (await scanInvoiceReminders(db, { now: NOW, appUrl: 'https://app.example.test' })).filter(
        (r) => r.workspaceId === ctx.workspaceId
      );

    it('schedules a reminder 7, 3 and 1 days before the due date, and when overdue', async () => {
      const in7 = await invoice({ dueDate: day('2026-10-08') });
      await invoice({ dueDate: day('2026-10-06') });
      const late = await invoice({ dueDate: day('2026-09-30'), status: 'overdue' });

      const created = await scan();

      expect(created.map((c) => [c.invoiceId, c.kind]).sort()).toEqual(
        [
          [in7.id, 'due_in_7'],
          [late.id, 'overdue_1'],
        ].sort()
      );
      const emails = await base.scheduledEmail.findMany({
        where: { workspaceId: ctx.workspaceId },
        orderBy: { type: 'asc' },
      });
      expect(emails.map((e) => [e.type, e.entityId, e.status])).toEqual([
        ['invoice_reminder:due_in_7', in7.id, 'pending'],
        ['invoice_reminder:overdue_1', late.id, 'pending'],
      ]);
      expect(emails[0]!.recipientEmail).toBe(`client-a-${run}@example.test`);
      expect(emails[0]!.body).toContain(`https://app.example.test/i/${in7.accessToken}`);
      expect(emails[1]!.subject).toMatch(/^Overdue: /);
      const jobs = await base.outboxEvent.findMany({ where: { workspaceId: ctx.workspaceId } });
      expect(jobs.map((j) => j.type)).toEqual(['email.send', 'email.send']);
    });

    it('schedules each reminder once, however often the scan runs that day', async () => {
      await invoice({ dueDate: day('2026-10-08') });

      await scan();
      const second = await scan();

      expect(second).toEqual([]);
      expect(await base.scheduledEmail.count({ where: { workspaceId: ctx.workspaceId } })).toBe(1);
      expect(await base.outboxEvent.count({ where: { workspaceId: ctx.workspaceId } })).toBe(1);
    });

    it('respects a workspace that turned reminders off or chose other days', async () => {
      await invoice({ dueDate: day('2026-10-08') });
      const in2 = await invoice({ dueDate: day('2026-10-03') });
      await base.workspace.update({
        where: { id: ctx.workspaceId },
        data: { settings: { invoiceDefaults: { reminderDays: [2] } } },
      });

      expect((await scan()).map((c) => [c.invoiceId, c.kind])).toEqual([[in2.id, 'due_in_2']]);

      await base.scheduledEmail.deleteMany({ where: { workspaceId: ctx.workspaceId } });
      await base.workspace.update({
        where: { id: ctx.workspaceId },
        data: { settings: { invoiceDefaults: { reminderEnabled: false } } },
      });
      expect(await scan()).toEqual([]);
      await base.workspace.update({ where: { id: ctx.workspaceId }, data: { settings: {} } });
    });

    it('does not remind about drafts, paid or voided invoices', async () => {
      for (const status of ['draft', 'paid', 'voided']) {
        await invoice({ dueDate: day('2026-10-08'), status });
      }

      expect(await scan()).toEqual([]);
    });
  });
});
