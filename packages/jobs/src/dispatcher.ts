import type { Job } from './types';

/**
 * How a job leaves the process that created it. The
 * processors are the same behind every implementation:
 *
 * - BullMQDispatcher adds to a Redis queue that a long-running worker (ECS)
 *   or the periodic drain (GitHub Actions) consumes;
 * - QStashDispatcher asks Upstash QStash to POST the job to the API's
 *   `/jobs/run/:type` endpoint, for hosts with no worker process;
 * - InlineDispatcher runs the job in the calling process, for tests.
 */
export interface JobDispatcher {
  dispatch(job: Job): Promise<void>;
}

/** Runs jobs in-process, in order, including the jobs those jobs dispatch. */
export class InlineDispatcher implements JobDispatcher {
  readonly dispatched: Job[] = [];
  private readonly seen = new Set<string>();
  private readonly queue: Job[] = [];

  constructor(private readonly run: (job: Job) => Promise<void>) {}

  async dispatch(job: Job): Promise<void> {
    // Same rule as the real queues: a job id is accepted once.
    if (this.seen.has(job.jobId)) return;
    this.seen.add(job.jobId);
    this.dispatched.push(job);
    this.queue.push(job);
  }

  /** Runs everything queued so far and whatever that queues. */
  async drain(): Promise<void> {
    for (let job = this.queue.shift(); job; job = this.queue.shift()) {
      await this.run(job);
    }
  }
}
