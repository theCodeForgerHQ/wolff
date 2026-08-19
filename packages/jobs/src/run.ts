import { completeOutboxEvent, failOutboxEvent } from '@wolff/core/outbox';
import { recordDeliveryExhausted } from '@wolff/core/webhooks';
import { processors } from './processors';
import { jobPayloads, type Job, type JobContext, type JobType } from './types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export interface RetryPolicy {
  attempts: number;
  /** Delay before retry n (1-based), in ms. */
  delayMs: (attemptsMade: number) => number;
}

const exponential = (baseMs: number) => (attemptsMade: number) => baseMs * 2 ** (attemptsMade - 1);

/** 8 attempts, waiting 1m, 5m, 30m, 2h, 6h, 12h, 24h between them. */
export const WEBHOOK_RETRY_DELAYS_MS = [
  MINUTE,
  5 * MINUTE,
  30 * MINUTE,
  2 * HOUR,
  6 * HOUR,
  12 * HOUR,
  24 * HOUR,
];

/** Attempts and backoff per job type, from the table in the design. */
export const RETRY_POLICIES: Record<JobType, RetryPolicy> = {
  'payments.reconcile': { attempts: 5, delayMs: exponential(30_000) },
  'webhooks.fanout': { attempts: 5, delayMs: exponential(30_000) },
  'webhooks.deliver': {
    attempts: WEBHOOK_RETRY_DELAYS_MS.length + 1,
    delayMs: (made) => WEBHOOK_RETRY_DELAYS_MS[made - 1] ?? 24 * HOUR,
  },
  'email.send': { attempts: 5, delayMs: exponential(MINUTE) },
  'email.payment_received': { attempts: 5, delayMs: exponential(MINUTE) },
  'recurring.generate': { attempts: 3, delayMs: exponential(30_000) },
  'recurring.invoice': { attempts: 3, delayMs: exponential(30_000) },
  'reminders.scan': { attempts: 5, delayMs: exponential(MINUTE) },
  'invoices.mark_overdue': { attempts: 3, delayMs: exponential(30_000) },
  'automations.tick': { attempts: 3, delayMs: exponential(30_000) },
  'pdf.render': { attempts: 3, delayMs: exponential(10_000) },
  'outbox.sweep': { attempts: 1, delayMs: () => 0 },
  'ai.index': { attempts: 3, delayMs: exponential(30_000) },
  'ai.sweep': { attempts: 1, delayMs: () => 0 },
  'reports.nightly': { attempts: 3, delayMs: exponential(MINUTE) },
};

export class InvalidJobError extends Error {
  constructor(type: string, detail: string) {
    super(`Invalid job ${type}: ${detail}`);
    this.name = 'InvalidJobError';
  }
}

/**
 * Runs one job: validates its payload, calls its processor, and on success
 * marks the outbox event it came from done. Throws when the processor throws;
 * whoever hosts the job (BullMQ worker, QStash endpoint) decides about retry.
 */
export async function runJob(ctx: JobContext, job: Job): Promise<void> {
  const schema = jobPayloads[job.type as JobType];
  if (!schema) throw new InvalidJobError(String(job.type), 'unknown type');
  const parsed = schema.safeParse(job.payload);
  if (!parsed.success) {
    throw new InvalidJobError(job.type, parsed.error.issues.map((i) => i.message).join('; '));
  }

  const processor = processors[job.type] as (ctx: JobContext, payload: unknown) => Promise<void>;
  await processor(ctx, parsed.data);
  if (job.outboxEventId) await completeOutboxEvent(ctx.db, job.outboxEventId, ctx.now());
}

/**
 * Called once, when a job has failed and will not be retried. Records the
 * failure where a person will look for it.
 */
export async function handleExhaustedJob(ctx: JobContext, job: Job, error: unknown): Promise<void> {
  if (job.outboxEventId) await failOutboxEvent(ctx.db, job.outboxEventId, error);

  if (job.type === 'webhooks.deliver') {
    const parsed = jobPayloads['webhooks.deliver'].safeParse(job.payload);
    if (parsed.success) await recordDeliveryExhausted(ctx.db, parsed.data);
  }
  if (job.type === 'email.send') {
    const parsed = jobPayloads['email.send'].safeParse(job.payload);
    if (parsed.success) {
      await ctx.db.scheduledEmail.updateMany({
        where: {
          id: parsed.data.scheduledEmailId,
          workspaceId: parsed.data.workspaceId,
          status: 'pending',
        },
        data: { status: 'failed' },
      });
    }
  }
}
