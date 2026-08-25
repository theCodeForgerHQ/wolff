import { relayOutboxToJobs } from '../relay';
import { createHash } from 'node:crypto';
import { formatMoney, renderPaymentReceived } from '@wolff/core/email';
import {
  findDueRecurringInvoices,
  generateRecurringInvoice,
  markOverdueInvoices,
  scanInvoiceReminders,
} from '@wolff/core/invoices';
import {
  listRunningAutomationRuns,
  scanAutomationTriggers,
  tickAutomationRun,
} from '@wolff/core/automations';
import { requeueStaleOutboxEvents } from '@wolff/core/outbox';
import { processProviderEvent, redriveStaleProviderEvents } from '@wolff/core/payments';
import { deliverWebhook, fanOutDomainEvent } from '@wolff/core/webhooks';
import type { JobContext, JobType, Processor } from '../types';

/**
 * One processor per job type. Each is idempotent: it may run again after a
 * crash, a retry or a duplicate delivery, and the second run changes nothing.
 */
const reconcilePayment: Processor<'payments.reconcile'> = async (ctx, { eventRowId }) => {
  await processProviderEvent(ctx.db, eventRowId);
};

const fanOutWebhooks: Processor<'webhooks.fanout'> = async (ctx, { outboxEventId }) => {
  // The outbox relay's own rows: read without a workspace, then act inside it.
  const event = await ctx.db.$unscoped.outboxEvent.findUnique({ where: { id: outboxEventId } });
  if (!event?.workspaceId) return;
  await fanOutDomainEvent(ctx.db, {
    id: event.id,
    workspaceId: event.workspaceId,
    type: event.type,
    payload: event.payload,
    createdAt: event.createdAt,
  });
};

const deliver: Processor<'webhooks.deliver'> = async (ctx, job) => {
  await deliverWebhook(ctx.db, job, {
    transport: ctx.webhooks,
    requireHttps: ctx.requireHttpsWebhooks,
    now: ctx.now(),
  });
};

const sendEmail: Processor<'email.send'> = async (ctx, { scheduledEmailId, workspaceId }) => {
  const email = await ctx.db.scheduledEmail.findFirst({
    where: { id: scheduledEmailId, workspaceId },
  });
  if (!email || email.status !== 'pending') return;

  try {
    await ctx.email.send({
      to: email.recipientEmail,
      subject: email.subject,
      html: email.body,
      idempotencyKey: `email:${email.id}`,
    });
  } catch (error) {
    await ctx.db.scheduledEmail.updateMany({
      where: { id: email.id, workspaceId },
      data: {
        retryCount: { increment: 1 },
        errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
      },
    });
    throw error;
  }
  await ctx.db.scheduledEmail.updateMany({
    where: { id: email.id, workspaceId, status: 'pending' },
    data: { status: 'sent', sentAt: ctx.now(), errorMessage: null },
  });
};

/** The same id for the same payment, so a repeated job stores one email. */
function receiptId(paymentId: string): string {
  const hex = createHash('sha256').update(`receipt:${paymentId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const sendPaymentReceipt: Processor<'email.payment_received'> = async (ctx, job) => {
  const { paymentId, workspaceId } = job;
  const payment = await ctx.db.payment.findFirst({
    where: { id: paymentId, workspaceId },
    include: {
      invoice: {
        select: {
          id: true,
          invoiceNumber: true,
          currency: true,
          client: { select: { name: true, email: true } },
          workspace: {
            select: { name: true, businessProfile: { select: { businessName: true } } },
          },
        },
      },
    },
  });
  if (!payment || !payment.invoice.client.email) return;

  const { invoice } = payment;
  const rendered = renderPaymentReceived({
    clientName: invoice.client.name,
    invoiceNumber: invoice.invoiceNumber,
    businessName: invoice.workspace.businessProfile?.businessName || invoice.workspace.name,
    amount: formatMoney(Number(payment.amount), invoice.currency),
    receiptUrl: payment.stripeReceiptUrl,
  });
  const id = receiptId(payment.id);
  await ctx.db.scheduledEmail.createMany({
    data: {
      id,
      workspaceId,
      type: 'payment_received',
      entityType: 'invoice',
      entityId: invoice.id,
      recipientEmail: invoice.client.email,
      recipientName: invoice.client.name,
      subject: rendered.subject,
      body: rendered.html,
      scheduledFor: ctx.now(),
    },
    skipDuplicates: true,
  });
  await sendEmail(ctx, { scheduledEmailId: id, workspaceId });
};

const generateRecurring: Processor<'recurring.generate'> = async (ctx) => {
  for (const due of await findDueRecurringInvoices(ctx.db, ctx.now())) {
    await ctx.dispatch({
      type: 'recurring.invoice',
      payload: due,
      jobId: `rec:${due.parentInvoiceId}:${due.periodKey}`,
    });
  }
};

const generateRecurringOne: Processor<'recurring.invoice'> = async (ctx, job) => {
  await generateRecurringInvoice(
    { db: ctx.db, workspaceId: job.workspaceId },
    job.parentInvoiceId,
    job.periodKey,
    ctx.now()
  );
};

const scanReminders: Processor<'reminders.scan'> = async (ctx) => {
  await scanInvoiceReminders(ctx.db, { now: ctx.now(), appUrl: ctx.appUrl });
};

const markOverdue: Processor<'invoices.mark_overdue'> = async (ctx) => {
  await markOverdueInvoices(ctx.db, ctx.now());
};

/** Where a rendered document is stored. Same document state, same key. */
export function pdfKey(input: {
  workspaceId: string;
  documentType: string;
  documentId: string;
  updatedAt: Date;
}): string {
  return `pdfs/${input.workspaceId}/${input.documentType}/${input.documentId}-${input.updatedAt.getTime()}.pdf`;
}

const renderPdf: Processor<'pdf.render'> = async (ctx, job) => {
  const { documentType, documentId, workspaceId } = job;
  const where = { id: documentId, workspaceId };
  const select = { accessToken: true, updatedAt: true, pdfUrl: true } as const;
  const document =
    documentType === 'invoice'
      ? await ctx.db.invoice.findFirst({ where, select })
      : await ctx.db.quote.findFirst({ where, select });
  if (!document) return;

  const key = pdfKey({ workspaceId, documentType, documentId, updatedAt: document.updatedAt });
  // This version is already stored: a repeated request renders nothing.
  if (document.pdfUrl === key) return;
  const base = ctx.appUrl.replace(/\/$/, '');
  const path = documentType === 'invoice' ? 'i' : 'q';
  const pdf = await ctx.pdf.render(`${base}/${path}/${document.accessToken}`);
  await ctx.storage.put(key, pdf, 'application/pdf');

  if (documentType === 'invoice') {
    // updateMany leaves updatedAt alone, so the key stays valid for this state.
    await ctx.db.$unscoped.$executeRaw`
      UPDATE invoices SET pdf_url = ${key} WHERE id = ${documentId} AND workspace_id = ${workspaceId}`;
  } else {
    await ctx.db.$unscoped.$executeRaw`
      UPDATE quotes SET pdf_url = ${key} WHERE id = ${documentId} AND workspace_id = ${workspaceId}`;
  }
};

const tickAutomation: Processor<'automations.tick'> = async (ctx, { runId }) => {
  if (!runId) {
    // The periodic tick: start runs for new subjects, then give every run
    // that is still going a tick. The database is the record, so a wake-up
    // job lost with Redis (or never scheduled, on the drain) costs at most
    // one period; ticking a run whose wait is not over does nothing.
    const now = ctx.now();
    const created = await scanAutomationTriggers(ctx.db, { now });
    for (const id of created) {
      await ctx.dispatch({
        type: 'automations.tick',
        payload: { runId: id },
        jobId: `automation:${id}:0`,
      });
    }
    const stamp = now.toISOString().slice(0, 16);
    for (const id of await listRunningAutomationRuns(ctx.db)) {
      if (created.includes(id)) continue;
      await ctx.dispatch({
        type: 'automations.tick',
        payload: { runId: id },
        jobId: `automation:${id}:tick:${stamp}`,
      });
    }
    return;
  }

  const run = await ctx.db.$unscoped.automationRun.findUnique({ where: { id: runId } });
  if (!run) return;

  const dispatch: Parameters<typeof tickAutomationRun>[2]['dispatch'] = async (
    dispatchedRunId,
    stepIndex,
    delayMs
  ) => {
    await ctx.dispatch({
      type: 'automations.tick',
      payload: { runId: dispatchedRunId },
      jobId: `automation:${dispatchedRunId}:${stepIndex}:wake`,
      delayMs,
    });
  };

  // Loop to execute consecutive action steps in one job invocation.
  let previousStep: number | null = null;
  while (true) {
    const after = await tickAutomationRun({ db: ctx.db, workspaceId: run.workspaceId }, runId, {
      dispatch,
      now: ctx.now(),
    });
    if (!after || after.status !== 'running') break;
    if (previousStep === after.currentStep) break; // no progress (e.g. waiting)
    previousStep = after.currentStep;
  }
};

/** Events per relay transaction: each is one publish, inside one DB transaction. */
const SWEEP_RELAY_BATCH = 20;
const SWEEP_RELAY_PASSES = 10;

const sweepOutbox: Processor<'outbox.sweep'> = async (ctx) => {
  await requeueStaleOutboxEvents(ctx.db, { now: ctx.now() });
  await redriveStaleProviderEvents(ctx.db, { now: ctx.now() });
  // Then relay what is due. A worker host also has a relay loop, so this is
  // redundant there (rows are claimed with SKIP LOCKED, so never doubled);
  // on Vercel + QStash nothing runs between requests, and this scheduled
  // sweep is the only thing that moves emails and webhook deliveries along.
  // Bounded: at most 200 events per run, the rest wait for the next one.
  const dispatcher = { dispatch: ctx.dispatch };
  for (let pass = 0; pass < SWEEP_RELAY_PASSES; pass++) {
    const { enqueued, failed } = await relayOutboxToJobs(ctx.db, dispatcher, {
      limit: SWEEP_RELAY_BATCH,
      now: ctx.now(),
    });
    if (enqueued + failed < SWEEP_RELAY_BATCH || failed > 0) return;
  }
};

const indexForAi: Processor<'ai.index'> = async (ctx, job) => {
  // The AI service is optional: without it the core product runs as before.
  if (!ctx.ai) return;
  await ctx.ai.index(job);
};

/** Live workspaces, listed across tenants (the sweeps' documented exemption). */
async function liveWorkspaceIds(ctx: JobContext): Promise<string[]> {
  const rows = await ctx.db.$unscoped.workspace.findMany({
    where: { deletedAt: null },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/**
 * Time the sweep may start new calls for. Each AI call does one bounded batch
 * (under 60 s), so the job ends inside Vercel's 300 s function limit; what is
 * left is picked up by the next scheduled run (the sweep is incremental).
 */
export const AI_SWEEP_BUDGET_MS = 200_000;

const sweepAiIndex: Processor<'ai.sweep'> = async (ctx) => {
  const ai = ctx.ai;
  if (!ai) return;
  const deadline = ctx.now().getTime() + AI_SWEEP_BUDGET_MS;
  // One call per workspace per round, scoped by that workspace's token, so a
  // big backlog in one workspace cannot starve the others.
  let pending = await liveWorkspaceIds(ctx);
  while (pending.length > 0) {
    const next: string[] = [];
    for (const id of pending) {
      if (ctx.now().getTime() >= deadline) return;
      if ((await ai.sweep(id)).more) next.push(id);
    }
    pending = next;
  }
};

/**
 * Time the nightly run may start new reports for. One report takes up to the
 * AI call's 60 s, so the run ends by ~260 s, inside Vercel's 300 s limit.
 */
export const REPORTS_BUDGET_MS = 200_000;

const nightlyReports: Processor<'reports.nightly'> = async (ctx, { after }) => {
  const ai = ctx.ai;
  if (!ai) return;
  const started = ctx.now();
  const deadline = started.getTime() + REPORTS_BUDGET_MS;
  // In id order so a run cut off at the budget resumes after its last report.
  const rows = await ctx.db.$unscoped.workspace.findMany({
    where: { deletedAt: null, ...(after ? { id: { gt: after } } : {}) },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  const failed: string[] = [];
  const errors: unknown[] = [];
  let last: string | undefined;
  for (const { id } of rows) {
    if (last !== undefined && ctx.now().getTime() >= deadline) {
      const day = started.toISOString().slice(0, 10);
      await ctx.dispatch({
        type: 'reports.nightly',
        payload: { after: last },
        jobId: `reports.nightly:${day}:${last}`,
      });
      break;
    }
    try {
      await ai.nightlyReport(id);
    } catch (error) {
      // One workspace's failure must not cost the others their report.
      failed.push(id);
      errors.push(error);
    }
    last = id;
  }
  if (failed.length > 0) {
    // Fails the job so it is retried and reported; reports are upserts, so a
    // retry rewrites the ones that succeeded without harm.
    throw new Error(
      `nightly report failed for ${failed.length} workspace(s): ${failed.join(', ')}`,
      { cause: errors }
    );
  }
};

export const processors: { [T in JobType]: Processor<T> } = {
  'payments.reconcile': reconcilePayment,
  'webhooks.fanout': fanOutWebhooks,
  'webhooks.deliver': deliver,
  'email.send': sendEmail,
  'email.payment_received': sendPaymentReceipt,
  'recurring.generate': generateRecurring,
  'recurring.invoice': generateRecurringOne,
  'reminders.scan': scanReminders,
  'invoices.mark_overdue': markOverdue,
  'automations.tick': tickAutomation,
  'pdf.render': renderPdf,
  'outbox.sweep': sweepOutbox,
  'ai.index': indexForAi,
  'ai.sweep': sweepAiIndex,
  'reports.nightly': nightlyReports,
};

export type { JobContext };
