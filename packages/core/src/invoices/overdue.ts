import type { Db } from '../context';
import { writeOutboxEvent } from '../outbox';
import { businessDate, fromDateString } from './dates';

/**
 * Moves unpaid invoices that are past their due date to `overdue` (job
 * `invoices.mark_overdue`). A pure state transition: running it again finds
 * nothing left to move.
 *
 * Only `sent` and `viewed` invoices move. A partly paid invoice keeps
 * `partial`, because `overdue` would hide that a payment was made; the UI
 * already shows it as overdue from its due date.
 *
 * A scheduled scan across all workspaces, hence the unscoped client.
 */
export async function markOverdueInvoices(db: Db, now: Date = new Date()): Promise<number> {
  const today = fromDateString(businessDate(now));
  const late = await db.$unscoped.invoice.findMany({
    where: { status: { in: ['sent', 'viewed'] }, dueDate: { lt: today }, deletedAt: null },
    select: { id: true, workspaceId: true },
    take: 1_000,
  });

  let moved = 0;
  for (const { id, workspaceId } of late) {
    await db.$transaction(async (tx) => {
      const updated = await tx.invoice.updateMany({
        where: { id, workspaceId, status: { in: ['sent', 'viewed'] } },
        data: { status: 'overdue' },
      });
      if (updated.count === 0) return;
      await tx.invoiceEvent.create({
        data: { invoiceId: id, eventType: 'overdue', actorType: 'system', metadata: {} },
      });
      await writeOutboxEvent(tx, {
        workspaceId,
        type: 'invoice.overdue',
        aggregateType: 'invoice',
        aggregateId: id,
        payload: { invoiceId: id, workspaceId },
      });
      moved += 1;
    });
  }
  return moved;
}
