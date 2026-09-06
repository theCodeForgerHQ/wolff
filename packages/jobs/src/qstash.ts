import { Receiver } from '@upstash/qstash';
import type { JobDispatcher } from './dispatcher';
import type { Job, JobType } from './types';

/**
 * The push runtime for hosts with no worker process. QStash
 * POSTs each job to `POST /jobs/run/:type` on the API, which runs the same
 * processor a BullMQ worker would. That URL is public, so the only thing
 * that makes a request a job is QStash's signature on it.
 */
export interface QStashPublisher {
  publishJSON(request: {
    url: string;
    body: unknown;
    deduplicationId?: string;
    retries?: number;
    /** Seconds to wait before delivering. */
    delay?: number;
  }): Promise<unknown>;
}

/** Retries QStash makes itself. Anything beyond that falls to the cron drain via the sweeper. */
export const QSTASH_RETRIES = 3;

/** Retries for scheduled runs; see syncQStashSchedules. */
export const SCHEDULE_RETRIES = 0;

export class QStashDispatcher implements JobDispatcher {
  private readonly apiUrl: string;

  constructor(private readonly options: { client: QStashPublisher; apiUrl: string }) {
    this.apiUrl = options.apiUrl.replace(/\/$/, '');
  }

  async dispatch(job: Job): Promise<void> {
    await this.options.client.publishJSON({
      url: `${this.apiUrl}/jobs/run/${job.type}`,
      body: job,
      // QStash allows only letters, digits, "-" and "_" in a deduplication id.
      deduplicationId: job.jobId.replace(/[^A-Za-z0-9_-]/g, '-'),
      retries: QSTASH_RETRIES,
      ...(job.delayMs && job.delayMs > 0 ? { delay: Math.ceil(job.delayMs / 1000) } : {}),
    });
  }
}

export type QStashVerifier = (request: {
  signature: string | undefined;
  /** The raw request body, byte for byte as received. */
  body: string;
  /** The public URL QStash called. */
  url: string;
}) => Promise<boolean>;

/**
 * Verifies the `Upstash-Signature` header: a JWT signed with one of the two
 * signing keys, issued by Upstash, for this URL, not expired, carrying the
 * SHA-256 of this body. Returns false for anything else; it never throws.
 */
export function createQStashVerifier(keys: {
  currentSigningKey: string;
  nextSigningKey: string;
}): QStashVerifier {
  if (!keys.currentSigningKey || !keys.nextSigningKey) {
    throw new Error('QStash signing keys are required to accept pushed jobs');
  }
  // devMode is switched off explicitly. Left undefined, the SDK reads
  // QSTASH_DEV from the environment and, when set, ignores these keys in
  // favour of the public keys of its local dev server.
  const receiver = new Receiver({ ...keys, devMode: false });

  return async ({ signature, body, url }) => {
    if (!signature) return false;
    try {
      return await receiver.verify({ signature, body, url });
    } catch {
      return false;
    }
  };
}

/**
 * The schedules of the free demo (owner decision 2026-08-23, a deliberate
 * deviation from the design's GitHub Actions cron; see docs/phase-2.md).
 * QStash calls `POST /jobs/run/:type` itself, signed, so nothing has to run
 * outside Vercel. Free tier: at most 10 schedules and 1,000 messages a day.
 * Every job has to end inside Vercel's 300 s function limit; the sweeps are
 * bounded per run and pick up where they stopped. UTC.
 *
 * Every schedule fires at minute 0, so the database (Neon suspends 5 minutes
 * after the last query) wakes at most once an hour. Spread over the hour, as
 * they were, the schedules kept it awake most of the day and used up the
 * free compute quota: every run failed from 2026-09-03 to the reset on
 * 11-01, and the failing invocations then used up Vercel's CPU allowance.
 * The frequent jobs run together in one hourly `scheduled.tick` (tick.ts).
 * About 26 messages a day.
 */
export const QSTASH_SCHEDULES: Record<string, { type: JobType; cron: string }> = {
  // Automations, recurring invoices, overdue (00:00), reminders (03:00), then
  // the outbox relay, so what they created is sent in the same run.
  tick: { type: 'scheduled.tick', cron: '0 * * * *' },
  // Re-embeds what changed. New and edited documents are indexed when they
  // change (the ai.index outbox event); this only catches what was missed.
  'ai-sweep': { type: 'ai.sweep', cron: '0 1 * * *' },
  // 01:30 IST, after the IST day has ended.
  'reports-nightly': { type: 'reports.nightly', cron: '0 20 * * *' },
  // Sunday 02:30 IST. Weekly: a full export is the heaviest job there is.
  backup: { type: 'db.backup', cron: '0 21 * * 0' },
};

/** The part of the QStash client the schedule sync uses. */
export interface QStashScheduleClient {
  schedules: {
    create(request: {
      destination: string;
      cron: string;
      body: string;
      scheduleId?: string;
      retries?: number;
      headers?: Record<string, string>;
    }): Promise<{ scheduleId: string }>;
    list(): Promise<{ scheduleId: string }[]>;
    delete(scheduleId: string): Promise<unknown>;
  };
}

/**
 * Creates or updates every schedule under `<prefix>-<name>` and deletes
 * schedules with that prefix that are no longer defined. Others are left alone.
 */
export async function syncQStashSchedules(
  client: QStashScheduleClient,
  apiUrl: string,
  prefix: string
): Promise<string[]> {
  const base = apiUrl.replace(/\/$/, '');
  const ids: string[] = [];
  for (const [name, { type, cron }] of Object.entries(QSTASH_SCHEDULES)) {
    const scheduleId = `${prefix}-${name}`;
    const job: Job = { type, payload: {}, jobId: `scheduled:${name}` };
    await client.schedules.create({
      destination: `${base}/jobs/run/${type}`,
      cron,
      body: JSON.stringify(job),
      headers: { 'content-type': 'application/json' },
      scheduleId,
      // A failed scheduled run is not retried: the next one is at most 30
      // minutes away, and retries against a database that is down only
      // multiply the failing invocations (and the Sentry alerts).
      retries: SCHEDULE_RETRIES,
    });
    ids.push(scheduleId);
  }
  for (const { scheduleId } of await client.schedules.list()) {
    if (scheduleId.startsWith(`${prefix}-`) && !ids.includes(scheduleId)) {
      await client.schedules.delete(scheduleId);
    }
  }
  return ids;
}
