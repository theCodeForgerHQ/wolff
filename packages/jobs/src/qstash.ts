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
 * outside Vercel. Free tier: at most 10 schedules and 1,000 messages a day;
 * these fire about 246 times a day, the rest is left for the jobs they fan
 * out to. Every job has to end inside Vercel's 300 s function limit; the
 * sweeps are bounded per run and pick up where they stopped. UTC.
 */
export const QSTASH_SCHEDULES: Record<string, { type: JobType; cron: string }> = {
  // Requeues stale events and relays what is due: emails, webhook deliveries.
  'outbox-sweep': { type: 'outbox.sweep', cron: '*/15 * * * *' },
  automations: { type: 'automations.tick', cron: '7,22,37,52 * * * *' },
  recurring: { type: 'recurring.generate', cron: '0 * * * *' },
  // Hourly rather than nightly: each run embeds a bounded batch, so a
  // backlog is worked off over a few hours instead of failing at 300 s.
  'ai-sweep': { type: 'ai.sweep', cron: '30 * * * *' },
  reminders: { type: 'reminders.scan', cron: '0 3 * * *' },
  overdue: { type: 'invoices.mark_overdue', cron: '15 0 * * *' },
  'reports-nightly': { type: 'reports.nightly', cron: '30 20 * * *' },
  // 02:30 IST, after the nightly reports. One file per day; see db.backup.
  backup: { type: 'db.backup', cron: '0 21 * * *' },
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
      retries: QSTASH_RETRIES,
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
