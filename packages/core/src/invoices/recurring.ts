import { randomBytes } from 'node:crypto';
import type { Prisma } from '@wolff/database';
import type { CoreContext, Db } from '../context';
import { writeOutboxEvent } from '../outbox';
import {
  addDays,
  addInterval,
  businessDate,
  daysBetween,
  fromDateString,
  periodKeyFor,
  toDateString,
} from './dates';

/**
 * Recurring invoices. A scheduler finds the parents that are due
 * and fans out one job per parent and period; each job generates at most one
 * invoice for that pair, however many times it runs.
 */
export interface DueRecurringInvoice {
  parentInvoiceId: string;
  workspaceId: string;
  periodKey: string;
}

/**
 * Parents whose next occurrence is today or earlier, counted in India.
 * A scheduled scan across all workspaces, so it uses the unscoped client;
 * each result carries its workspace for the scoped work that follows.
 */
export async function findDueRecurringInvoices(
  db: Db,
  now: Date = new Date()
): Promise<DueRecurringInvoice[]> {
  const parents = await db.$unscoped.invoice.findMany({
    where: {
      isRecurring: true,
      deletedAt: null,
      nextRecurringDate: { lte: fromDateString(businessDate(now)) },
    },
    select: { id: true, workspaceId: true, nextRecurringDate: true, recurringInterval: true },
    orderBy: { createdAt: 'asc' },
  });
  return parents.map((parent) => ({
    parentInvoiceId: parent.id,
    workspaceId: parent.workspaceId,
    periodKey: periodKeyFor(
      toDateString(parent.nextRecurringDate!),
      parent.recurringInterval ?? 'monthly'
    ),
  }));
}

export type GenerateOutcome =
  | { outcome: 'created'; invoiceId: string }
  /** The invoice for this period exists already, or the period is not the one owed. */
  | { outcome: 'skipped' }
  /** The series' end date has passed; recurring was switched off. */
  | { outcome: 'ended' }
  | { outcome: 'not_found' };

const PERIOD_INDEX = 'invoices_parent_period_key';

/** True for the unique violation of the (parent, period) index. */
function isDuplicatePeriod(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const known = error as { code?: string; meta?: unknown; message?: string };
  return (
    known.code === 'P2002' &&
    (JSON.stringify(known.meta ?? {}).includes('recurring_period_key') ||
      JSON.stringify(known.meta ?? {}).includes(PERIOD_INDEX) ||
      (known.message ?? '').includes(PERIOD_INDEX))
  );
}

async function nextInvoiceNumber(tx: Prisma.TransactionClient, workspaceId: string) {
  const sequence = await tx.numberSequence.upsert({
    where: { workspaceId_type: { workspaceId, type: 'invoice' } },
    update: { currentValue: { increment: 1 } },
    create: { workspaceId, type: 'invoice', prefix: 'INV', currentValue: 1, padding: 4 },
  });
  const parts = [
    (sequence.prefix || 'INV').replace(/-$/, ''),
    String(sequence.currentValue).padStart(sequence.padding, '0'),
  ];
  if (sequence.suffix) parts.push(sequence.suffix);
  return parts.join('-');
}

/**
 * Generates the invoice of one period from a recurring parent, in one
 * transaction: number, copy, audit events, the parent's next date, and the
 * `invoice.created` outbox event. A second run for the same parent and
 * period returns `skipped`; the partial unique index is the backstop when
 * two runs race.
 */
export async function generateRecurringInvoice(
  ctx: CoreContext,
  parentInvoiceId: string,
  periodKey: string,
  now: Date = new Date()
): Promise<GenerateOutcome> {
  const { workspaceId } = ctx;
  const today = businessDate(now);

  try {
    return await ctx.db.$unscoped.$transaction(async (tx) => {
      // Serialise runs for the same parent; the loser then sees the child.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM invoices
        WHERE id = ${parentInvoiceId} AND workspace_id = ${workspaceId} AND deleted_at IS NULL
        FOR UPDATE`;
      if (!locked[0]) return { outcome: 'not_found' as const };

      const parent = await tx.invoice.findFirstOrThrow({
        where: { id: parentInvoiceId, workspaceId },
        include: { lineItems: { orderBy: { sortOrder: 'asc' } } },
      });

      const existing = await tx.invoice.findFirst({
        where: { workspaceId, parentInvoiceId, recurringPeriodKey: periodKey },
        select: { id: true },
      });
      if (existing) return { outcome: 'skipped' as const };
      if (!parent.isRecurring || !parent.nextRecurringDate) return { outcome: 'skipped' as const };

      const interval = parent.recurringInterval ?? 'monthly';
      if (periodKeyFor(toDateString(parent.nextRecurringDate), interval) !== periodKey) {
        return { outcome: 'skipped' as const };
      }

      const endDate = parent.recurringEndDate ? toDateString(parent.recurringEndDate) : null;
      if (endDate && today > endDate) {
        await tx.invoice.update({
          where: { id: parent.id, workspaceId },
          data: { isRecurring: false, nextRecurringDate: null },
        });
        return { outcome: 'ended' as const };
      }

      const termDays = daysBetween(toDateString(parent.issueDate), toDateString(parent.dueDate));
      const autoSend = parent.recurringAutoSend;
      const created = await tx.invoice.create({
        data: {
          workspaceId,
          clientId: parent.clientId,
          projectId: parent.projectId,
          parentInvoiceId: parent.id,
          recurringPeriodKey: periodKey,
          invoiceNumber: await nextInvoiceNumber(tx, workspaceId),
          title: parent.title || 'Invoice',
          status: autoSend ? 'sent' : 'draft',
          currency: parent.currency,
          accessToken: randomBytes(32).toString('hex'),
          issueDate: fromDateString(today),
          dueDate: fromDateString(addDays(today, termDays > 0 ? termDays : 30)),
          subtotal: parent.subtotal,
          discountType: parent.discountType,
          discountValue: parent.discountValue,
          discountAmount: parent.discountAmount,
          taxTotal: parent.taxTotal,
          total: parent.total,
          amountDue: parent.total,
          amountPaid: 0,
          notes: parent.notes,
          terms: parent.terms,
          settings: parent.settings as Prisma.InputJsonValue,
          sentAt: autoSend ? now : null,
          lineItems: {
            create: parent.lineItems.map((item, index) => ({
              name: item.name,
              description: item.description,
              quantity: item.quantity,
              rate: item.rate,
              amount: item.amount,
              taxRate: item.taxRate,
              taxAmount: item.taxAmount,
              sortOrder: index,
            })),
          },
          events: {
            create: [
              {
                eventType: 'created',
                actorType: 'system',
                metadata: { trigger: 'recurring', parentInvoiceId: parent.id, periodKey },
              },
              ...(autoSend
                ? [
                    {
                      eventType: 'sent',
                      actorType: 'system',
                      metadata: { trigger: 'recurring_auto_send' },
                    },
                  ]
                : []),
            ],
          },
        },
        select: { id: true },
      });

      // The next occurrence counts from today, so a series that fell behind
      // produces one invoice, not one per missed period.
      const next = addInterval(today, interval);
      const ended = endDate !== null && next > endDate;
      await tx.invoice.update({
        where: { id: parent.id, workspaceId },
        data: ended
          ? { isRecurring: false, nextRecurringDate: null }
          : { nextRecurringDate: fromDateString(next) },
      });

      await writeOutboxEvent(tx, {
        workspaceId,
        type: 'invoice.created',
        aggregateType: 'invoice',
        aggregateId: created.id,
        payload: { invoiceId: created.id, workspaceId },
      });

      return { outcome: 'created' as const, invoiceId: created.id };
    });
  } catch (error) {
    if (isDuplicatePeriod(error)) return { outcome: 'skipped' };
    throw error;
  }
}
