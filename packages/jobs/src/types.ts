import type { Db } from '@wolff/core/context';
import type { WebhookTransport } from '@wolff/core/webhooks';
import type { BackupStore } from './backup';
import { z } from 'zod';

/**
 * Job types and their payloads. Payloads carry ids only: the queue is not
 * the record and must hold no personal data. Each processor
 * re-reads what it needs from the database.
 */
const id = z.string().min(1).max(100);

export const jobPayloads = {
  'payments.reconcile': z.object({ eventRowId: id }),
  'webhooks.fanout': z.object({ outboxEventId: id }),
  'webhooks.deliver': z.object({ deliveryId: id, workspaceId: id }),
  'email.send': z.object({ scheduledEmailId: id, workspaceId: id }),
  'email.payment_received': z.object({ paymentId: id, workspaceId: id }),
  'recurring.generate': z.object({}),
  'recurring.invoice': z.object({
    parentInvoiceId: id,
    workspaceId: id,
    periodKey: z.string().max(10),
  }),
  'reminders.scan': z.object({}),
  'invoices.mark_overdue': z.object({}),
  'automations.tick': z.object({ runId: id.optional() }),
  'pdf.render': z.object({
    documentType: z.enum(['invoice', 'quote']),
    documentId: id,
    workspaceId: id,
  }),
  'outbox.sweep': z.object({}),
  'ai.index': z.object({
    workspaceId: id,
    sourceType: z.enum(['quote', 'invoice', 'contract', 'client_note']),
    sourceId: id,
  }),
  'ai.sweep': z.object({}),
  // `after`: resume cursor, the last workspace id a cut-off run reported.
  'reports.nightly': z.object({ after: id.optional() }),
  'db.backup': z.object({}),
} as const;

export type JobType = keyof typeof jobPayloads;
export type JobPayload<T extends JobType> = z.infer<(typeof jobPayloads)[T]>;

export const JOB_TYPES = Object.keys(jobPayloads) as JobType[];

export function isJobType(value: string): value is JobType {
  return Object.hasOwn(jobPayloads, value);
}

/** A job as a dispatcher sends it and a processor receives it. */
export interface Job<T extends JobType = JobType> {
  type: T;
  payload: JobPayload<T>;
  /** Stable id; the queue drops a second job with the same id. */
  jobId: string;
  /** The outbox event this job works off, if any. Marked done when the job finishes. */
  outboxEventId?: string;
  traceId?: string;
  /**
   * Run no earlier than this many milliseconds from now. A hint: a delayed
   * job lost with Redis is made up for by the periodic tick that re-derives
   * due work from the database.
   */
  delayMs?: number;
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  /** Sent as Resend's Idempotency-Key, so a retried job sends one email. */
  idempotencyKey: string;
  /** Set by the demo redirect: `to` is the redirect, not the intended recipient. */
  redirected?: boolean;
}

export interface EmailTransport {
  send(message: EmailMessage): Promise<void>;
}

export interface PdfRenderer {
  /** Renders the document's public page to PDF. */
  render(url: string): Promise<Uint8Array>;
}

/** The AI service's indexing endpoints (job `ai.index`). */
export interface AiIndexer {
  index(input: { workspaceId: string; sourceType: string; sourceId: string }): Promise<void>;
  /**
   * Re-index one bounded batch of what changed in a workspace since it was
   * last indexed; `more` is true while a backlog is left.
   */
  sweep(workspaceId: string): Promise<{ more: boolean }>;
  /** Build and store one workspace's nightly report. */
  nightlyReport(workspaceId: string): Promise<void>;
}

export interface ObjectStorage {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
}

/** Everything a processor may touch. Built once per process. */
export interface JobContext {
  db: Db;
  /** Queues follow-up jobs (fan-out). */
  dispatch: (job: Job) => Promise<void>;
  email: EmailTransport;
  webhooks: WebhookTransport;
  pdf: PdfRenderer;
  storage: ObjectStorage;
  /** Absent when no AI service is configured; AI jobs then do nothing. */
  ai?: AiIndexer;
  /** Where `db.backup` writes. Absent: the job fails, so a missing bucket is noticed. */
  backups?: { store: BackupStore; keepDays: number; schemas: string[]; exclude?: string[] };
  /** Public origin of the web app, for links in emails and PDF rendering. */
  appUrl: string;
  requireHttpsWebhooks: boolean;
  now: () => Date;
}

export type Processor<T extends JobType> = (
  ctx: JobContext,
  payload: JobPayload<T>
) => Promise<void>;
