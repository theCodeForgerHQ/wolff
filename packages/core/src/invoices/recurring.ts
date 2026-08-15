import { randomBytes } from 'node:crypto';
import type { Prisma } from '@wolff/database';
import type { CoreContext, Db, DbTx } from '../context';
import { CoreError } from '../errors';
import { allocateSerialNumber } from '../gst/numbering';
import { writeOutboxEvent } from '../outbox';
import { assertReadyToIssue, gstInvoiceColumns, gstLinesFrom, priceForWorkspace } from './gst';
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
  // The composite unique key includes financial_year, which is nullable for
  // non-GST workspaces. Prisma's generated input type does not allow null in
  // the compound key, so we lock the row with a raw query and upsert by id.
  const [existing] = await tx.$queryRaw<
    Array<{
      id: string;
      prefix: string | null;
      suffix: string | null;
      padding: number;
      current_value: number;
    }>
  >`
    SELECT id, prefix, suffix, padding, current_value FROM number_sequences
    WHERE workspace_id = ${workspaceId} AND type = ${'invoice'} AND financial_year IS NULL
    FOR UPDATE`;

  let sequence: {
    prefix: string | null;
    suffix: string | null;
    padding: number;
    currentValue: number;
  };
  if (existing) {
    const updated = await tx.numberSequence.update({
      where: { id: existing.id },
      data: { currentValue: { increment: 1 } },
    });
    sequence = updated;
  } else {
    sequence = await tx.numberSequence.create({
      data: {
        workspaceId,
        type: 'invoice',
        financialYear: null,
        prefix: 'INV',
        currentValue: 1,
        padding: 4,
      },
    });
  }
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
      // In a GST workspace the copy is priced by the engine and numbered in
      // the FY of its issue date, like any other GST invoice; it is created
      // as a draft and sent only once Rule 46 passes (below).
      const guarded = tx as unknown as DbTx;
      const client = await tx.client.findFirstOrThrow({
        where: { id: parent.clientId, workspaceId },
      });
      const gst = await priceForWorkspace(guarded, workspaceId, {
        client,
        lines: gstLinesFrom(parent.lineItems),
        discountAmount: Number(parent.discountAmount),
        placeOfSupply: parent.placeOfSupply,
        reverseCharge: parent.reverseCharge,
      });
      const autoSend = parent.recurringAutoSend && !gst;
      const invoiceNumber = gst
        ? (
            await allocateSerialNumber(guarded, {
              workspaceId,
              type: 'invoice',
              prefix: 'INV',
              date: now,
            })
          ).serialNumber
        : await nextInvoiceNumber(tx, workspaceId);
      const created = await tx.invoice.create({
        data: {
          workspaceId,
          clientId: parent.clientId,
          projectId: parent.projectId,
          parentInvoiceId: parent.id,
          recurringPeriodKey: periodKey,
          invoiceNumber,
          title: parent.title || 'Invoice',
          status: autoSend ? 'sent' : 'draft',
          currency: parent.currency,
          accessToken: randomBytes(32).toString('hex'),
          issueDate: fromDateString(today),
          dueDate: fromDateString(addDays(today, termDays > 0 ? termDays : 30)),
          ...(gst
            ? { ...gstInvoiceColumns(gst), amountDue: gst.invoice.total }
            : {
                subtotal: parent.subtotal,
                discountType: parent.discountType,
                discountValue: parent.discountValue,
                discountAmount: parent.discountAmount,
                taxTotal: parent.taxTotal,
                total: parent.total,
                amountDue: parent.total,
              }),
          amountPaid: 0,
          notes: parent.notes,
          terms: parent.terms,
          settings: parent.settings as Prisma.InputJsonValue,
          sentAt: autoSend ? now : null,
          lineItems: {
            create: gst
              ? gst.lines
              : parent.lineItems.map((item, index) => ({
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

      if (gst && parent.recurringAutoSend) {
        await sendIfIssuable(guarded, workspaceId, created.id, now);
      }

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

/**
 * Auto-send for a GST copy: it leaves draft only if Rule 46 passes. If it
 * does not, it stays a draft and its audit trail says why, for the owner to
 * complete and send.
 */
async function sendIfIssuable(
  tx: DbTx,
  workspaceId: string,
  invoiceId: string,
  now: Date
): Promise<void> {
  try {
    await assertReadyToIssue(tx, workspaceId, invoiceId);
  } catch (error) {
    if (!(error instanceof CoreError)) throw error;
    await tx.invoiceEvent.create({
      data: {
        invoiceId,
        eventType: 'auto_send_blocked',
        actorType: 'system',
        metadata: {
          reason: error.message,
          details: (error.details ?? {}) as Prisma.InputJsonValue,
        },
      },
    });
    return;
  }
  await tx.invoice.update({
    where: { id: invoiceId, workspaceId },
    data: { status: 'sent', sentAt: now },
  });
  await tx.invoiceEvent.create({
    data: {
      invoiceId,
      eventType: 'sent',
      actorType: 'system',
      metadata: { trigger: 'recurring_auto_send' },
    },
  });
}
