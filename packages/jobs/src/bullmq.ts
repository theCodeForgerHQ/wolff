import { Queue, Worker, type ConnectionOptions, type Job as BullJob } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { PRODUCT_SLUG } from '@wolff/core/brand';
import type { Db } from '@wolff/core/context';
import type { JobDispatcher } from './dispatcher';
import type { RelayOptions } from '@wolff/core/outbox';
import { relayOutboxToJobs } from './relay';
import { RETRY_POLICIES, handleExhaustedJob, runJob } from './run';
import { isJobType, type Job, type JobContext, type JobType } from './types';

/**
 * The BullMQ runtime: one queue on one Redis, consumed by a worker
 * that runs continuously (ECS, docker compose) or by a drain run that starts,
 * empties the queue and exits (GitHub Actions in the free demo).
 *
 * One queue for all job types, not one per type. Every BullMQ worker holds
 * its own blocking Redis connection, and the free Redis plan the demo uses
 * caps connections; a drain with eleven workers would not fit.
 */
export const QUEUE_NAME = `${PRODUCT_SLUG}-jobs`;
export const QUEUE_PREFIX = 'bull';

const DAY = 24 * 60 * 60;

/** BullMQ requires `maxRetriesPerRequest: null` on the connection workers block on. */
export function createRedis(url: string): Redis {
  return new IORedis(url, {
    maxRetriesPerRequest: null,
    // `rediss://` URLs (Redis Cloud, ElastiCache in transit) negotiate TLS.
    ...(url.startsWith('rediss://') ? { tls: {} } : {}),
  });
}

export function createJobQueue(connection: ConnectionOptions, name: string = QUEUE_NAME): Queue {
  return new Queue(name, { connection, prefix: QUEUE_PREFIX });
}

interface QueuedData {
  payload: unknown;
  outboxEventId?: string;
  traceId?: string;
  /** The id as the application knows it; BullMQ's own id cannot contain ":". */
  jobId: string;
}

/** BullMQ rejects ":" in custom job ids, so `outbox:<id>` is stored as `outbox-<id>`. */
export const toBullJobId = (jobId: string): string => jobId.replace(/:/g, '-');

export class QueueUnreachableError extends Error {
  constructor(timeoutMs: number) {
    super(`The job queue did not accept a job within ${timeoutMs} ms`);
    this.name = 'QueueUnreachableError';
  }
}

export class BullMQDispatcher implements JobDispatcher {
  constructor(
    private readonly queue: Queue,
    /**
     * How long to wait for Redis. While Redis is down BullMQ's `add` does not
     * fail, it waits for the connection; without a limit the relay would hold
     * its transaction, and the rows it locked, for as long as Redis is away.
     */
    private readonly timeoutMs: number = 5_000
  ) {}

  async dispatch(job: Job): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new QueueUnreachableError(this.timeoutMs)), this.timeoutMs);
    });
    try {
      // If the add completes after the timeout, the job is queued while its
      // outbox event is still pending. The next relay pass adds it again under
      // the same id, which BullMQ ignores.
      const add = this.add(job);
      add.catch(() => {});
      await Promise.race([add, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async add(job: Job): Promise<void> {
    const data: QueuedData = {
      payload: job.payload,
      outboxEventId: job.outboxEventId,
      traceId: job.traceId,
      jobId: job.jobId,
    };
    await this.queue.add(job.type, data, {
      // A second add with the same id is ignored: this is the dedupe.
      jobId: toBullJobId(job.jobId),
      attempts: RETRY_POLICIES[job.type].attempts,
      backoff: { type: 'custom' },
      // Redis is not the record (the database is), so finished jobs are trimmed.
      removeOnComplete: { count: 100 },
      removeOnFail: { age: 7 * DAY, count: 500 },
    });
  }
}

function toJob(bull: BullJob): Job {
  const data = (bull.data ?? {}) as Partial<QueuedData>;
  return {
    type: bull.name as JobType,
    payload: (data.payload ?? {}) as Job['payload'],
    jobId: data.jobId ?? bull.id ?? bull.name,
    outboxEventId: data.outboxEventId,
    traceId: data.traceId,
  } as Job;
}

export interface WorkerOptions {
  connection: ConnectionOptions;
  ctx: JobContext;
  queueName?: string;
  concurrency?: number;
  /** Multiplies every retry delay. 1 in production; tests use a small fraction. */
  delayScale?: number;
  /** Wraps each job run, e.g. in a trace span. */
  wrap?: (job: Job, run: () => Promise<void>) => Promise<void>;
  onError?: (error: unknown, job?: Job) => void;
}

export function startJobWorker(options: WorkerOptions): Worker {
  const { ctx, delayScale = 1 } = options;
  const worker = new Worker(
    options.queueName ?? QUEUE_NAME,
    async (bull) => {
      const job = toJob(bull);
      const run = () => runJob(ctx, job);
      await (options.wrap ? options.wrap(job, run) : run());
    },
    {
      connection: options.connection,
      prefix: QUEUE_PREFIX,
      concurrency: options.concurrency ?? 5,
      settings: {
        backoffStrategy: (attemptsMade, _type, _error, bull) => {
          const type = bull?.name;
          const policy = type && isJobType(type) ? RETRY_POLICIES[type] : undefined;
          return Math.ceil((policy?.delayMs(attemptsMade) ?? 30_000) * delayScale);
        },
      },
    }
  );

  worker.on('failed', (bull, error) => {
    if (!bull) return;
    const job = toJob(bull);
    options.onError?.(error, job);
    // Only the last failure is final; earlier ones are retried by BullMQ.
    if (bull.attemptsMade >= (bull.opts.attempts ?? 1)) {
      handleExhaustedJob(ctx, job, error).catch((e) => options.onError?.(e, job));
    }
  });
  worker.on('error', (error) => options.onError?.(error));
  return worker;
}

/** Cron schedules of the design, all in UTC. The key is the scheduler id. */
export const SCHEDULES: Record<string, { type: JobType; pattern?: string; everyMs?: number }> = {
  recurring: { type: 'recurring.generate', pattern: '0 * * * *' },
  reminders: { type: 'reminders.scan', pattern: '0 3 * * *' },
  overdue: { type: 'invoices.mark_overdue', pattern: '15 0 * * *' },
  'outbox-sweep': { type: 'outbox.sweep', everyMs: 5 * 60_000 },
};

/** Registers (or updates) the repeating jobs. Safe to call on every start. */
export async function registerSchedulers(queue: Queue): Promise<string[]> {
  for (const [id, schedule] of Object.entries(SCHEDULES)) {
    await queue.upsertJobScheduler(
      id,
      schedule.pattern ? { pattern: schedule.pattern, tz: 'UTC' } : { every: schedule.everyMs },
      {
        name: schedule.type,
        data: { payload: {}, jobId: `scheduled:${id}` } satisfies QueuedData,
        opts: {
          attempts: RETRY_POLICIES[schedule.type].attempts,
          backoff: { type: 'custom' },
          removeOnComplete: { count: 100 },
          removeOnFail: { age: 7 * DAY, count: 500 },
        },
      }
    );
  }
  return Object.keys(SCHEDULES);
}

export interface RelayHandle {
  stop(): Promise<void>;
}

/**
 * The outbox relay loop: every `intervalMs` it moves due events onto the
 * queue. A failed pass (Redis down) is reported and tried again on the next
 * tick; the events stay pending in the database meanwhile.
 */
export function startOutboxRelay(options: {
  db: Db;
  dispatcher: JobDispatcher;
  intervalMs?: number;
  relay?: RelayOptions;
  onError?: (error: unknown) => void;
}): RelayHandle {
  let stopped = false;
  let running: Promise<unknown> = Promise.resolve();
  const tick = () => {
    if (stopped) return;
    running = relayOutboxToJobs(options.db, options.dispatcher, options.relay)
      .catch((error) => options.onError?.(error))
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, options.intervalMs ?? 2_000);
      });
  };
  let timer: NodeJS.Timeout = setTimeout(tick, 0);
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}

export interface DrainSummary {
  relayed: number;
  completed: number;
  failed: number;
  remaining: number;
  timedOut: boolean;
}

/**
 * The drain run (`worker:drain`): do the scheduled work that is
 * due, relay the outbox, work the queue until it is empty or `maxMs` has
 * passed, then stop. The scheduled processors are idempotent per period, so
 * running them on every drain is the same as a scheduler having fired.
 */
export async function drainJobs(options: {
  connection: ConnectionOptions;
  ctx: JobContext;
  queueName?: string;
  maxMs?: number;
  delayScale?: number;
  scheduled?: JobType[];
  /** Narrows which outbox events the drain relays. */
  relay?: RelayOptions;
  onError?: (error: unknown, job?: Job) => void;
}): Promise<DrainSummary> {
  const queue = createJobQueue(options.connection, options.queueName);
  const dispatcher = new BullMQDispatcher(queue);
  const relayOptions = options.relay ?? {};
  const deadline = Date.now() + (options.maxMs ?? 10 * 60_000);
  const scheduled = options.scheduled ?? [
    'outbox.sweep',
    'recurring.generate',
    'invoices.mark_overdue',
    'reminders.scan',
  ];

  let completed = 0;
  let failed = 0;
  const worker = startJobWorker({
    ...options,
    ctx: { ...options.ctx, dispatch: (j) => dispatcher.dispatch(j) },
  });
  worker.on('completed', () => (completed += 1));
  worker.on('failed', (bull) => {
    if (bull && bull.attemptsMade >= (bull.opts.attempts ?? 1)) failed += 1;
  });

  const stamp = new Date().toISOString().slice(0, 13);
  for (const type of scheduled) {
    await dispatcher.dispatch({ type, payload: {}, jobId: `drain:${type}:${stamp}` } as Job);
  }

  let relayed = 0;
  let remaining = 0;
  let idlePasses = 0;
  while (Date.now() < deadline) {
    const pass = await relayOutboxToJobs(options.ctx.db, dispatcher, relayOptions);
    relayed += pass.enqueued;
    const counts = await queue.getJobCounts('waiting', 'active', 'prioritized', 'waiting-children');
    remaining = Object.values(counts).reduce((sum, n) => sum + n, 0);
    // Two quiet passes in a row: a job that just finished may have written
    // new outbox events, which the next pass picks up.
    idlePasses = pass.enqueued === 0 && remaining === 0 ? idlePasses + 1 : 0;
    if (idlePasses >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const timedOut = Date.now() >= deadline;
  await worker.close();
  await queue.close();
  return { relayed, completed, failed, remaining, timedOut };
}

/** Queue depth by state, for `/metrics` and the drain log. */
export async function queueCounts(queue: Queue): Promise<Record<string, number>> {
  return queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
}
