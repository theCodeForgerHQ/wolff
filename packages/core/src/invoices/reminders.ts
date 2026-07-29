import { createHash } from 'node:crypto';
import type { Db } from '../context';
import { formatMoney, renderInvoiceReminder } from '../email/templates';
import { writeOutboxEvent } from '../outbox';
import { addDays, businessDate, daysBetween, fromDateString, toDateString } from './dates';

/**
 * Invoice reminders (`reminders.scan`). The scan decides which
 * reminders are owed today and stores each as a ScheduledEmail with an
 * `email.send` outbox event; sending is a separate job.
 *
 * Before the due date the workspace's `reminderDays` setting applies
 * (default 7, 3 and 1 days). After it, reminders go out on fixed days; the
 * spec does not give a schedule for those, so this is a choice.
 */
export const DEFAULT_REMINDER_DAYS = [7, 3, 1];
export const OVERDUE_REMINDER_DAYS = [1, 7, 14, 30];
export const EMAIL_SEND_EVENT = 'email.send';

export interface ScheduledReminder {
  scheduledEmailId: string;
  workspaceId: string;
  invoiceId: string;
  kind: string;
}

interface ReminderSettings {
  reminderEnabled?: unknown;
  reminderDays?: unknown;
}

function reminderSettings(settings: unknown): { enabled: boolean; days: number[] } {
  const defaults = ((settings ?? {}) as { invoiceDefaults?: ReminderSettings }).invoiceDefaults;
  const days = Array.isArray(defaults?.reminderDays)
    ? defaults.reminderDays.filter((d): d is number => Number.isInteger(d) && d > 0 && d <= 365)
    : DEFAULT_REMINDER_DAYS;
  return { enabled: defaults?.reminderEnabled !== false, days };
}

/** The same id for the same invoice, kind and day, so a repeated scan inserts nothing. */
function reminderId(invoiceId: string, kind: string, date: string): string {
  const hex = createHash('sha256').update(`reminder:${invoiceId}:${kind}:${date}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function scanInvoiceReminders(
  db: Db,
  options: { now?: Date; appUrl: string }
): Promise<ScheduledReminder[]> {
  const now = options.now ?? new Date();
  const today = businessDate(now);

  // A scheduled scan across all workspaces; every write below is scoped.
  const invoices = await db.$unscoped.invoice.findMany({
    where: {
      status: { in: ['sent', 'viewed', 'partial', 'overdue'] },
      deletedAt: null,
      amountDue: { gt: 0 },
      // The widest window any reminder can fall in.
      dueDate: {
        gte: fromDateString(addDays(today, -Math.max(...OVERDUE_REMINDER_DAYS))),
        lte: fromDateString(addDays(today, 365)),
      },
    },
    select: {
      id: true,
      workspaceId: true,
      invoiceNumber: true,
      accessToken: true,
      amountDue: true,
      currency: true,
      dueDate: true,
      client: { select: { name: true, email: true } },
      workspace: {
        select: { name: true, settings: true, businessProfile: { select: { businessName: true } } },
      },
    },
  });

  const scheduled: ScheduledReminder[] = [];
  for (const invoice of invoices) {
    const { enabled, days } = reminderSettings(invoice.workspace.settings);
    if (!enabled || !invoice.client.email) continue;

    const dueDate = toDateString(invoice.dueDate);
    const untilDue = daysBetween(today, dueDate);
    let kind: string | null = null;
    if (untilDue > 0 && days.includes(untilDue)) kind = `due_in_${untilDue}`;
    else if (untilDue < 0 && OVERDUE_REMINDER_DAYS.includes(-untilDue))
      kind = `overdue_${-untilDue}`;
    if (!kind) continue;

    const { workspaceId } = invoice;
    const id = reminderId(invoice.id, kind, today);
    const email = renderInvoiceReminder({
      clientName: invoice.client.name,
      invoiceNumber: invoice.invoiceNumber,
      invoiceUrl: `${options.appUrl.replace(/\/$/, '')}/i/${invoice.accessToken}`,
      businessName: invoice.workspace.businessProfile?.businessName || invoice.workspace.name,
      amount: formatMoney(Number(invoice.amountDue), invoice.currency),
      dueDate,
      daysOverdue: Math.max(0, -untilDue),
    });

    const created = await db.$transaction(async (tx) => {
      const inserted = await tx.scheduledEmail.createMany({
        data: {
          id,
          workspaceId,
          type: `invoice_reminder:${kind}`,
          entityType: 'invoice',
          entityId: invoice.id,
          recipientEmail: invoice.client.email,
          recipientName: invoice.client.name,
          subject: email.subject,
          body: email.html,
          scheduledFor: now,
        },
        skipDuplicates: true,
      });
      if (inserted.count === 0) return false;
      await writeOutboxEvent(tx, {
        workspaceId,
        type: EMAIL_SEND_EVENT,
        aggregateType: 'scheduled_email',
        aggregateId: id,
        payload: { scheduledEmailId: id, workspaceId },
      });
      return true;
    });
    if (created) scheduled.push({ scheduledEmailId: id, workspaceId, invoiceId: invoice.id, kind });
  }
  return scheduled;
}
