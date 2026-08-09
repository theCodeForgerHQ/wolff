import { Receiver } from '@upstash/qstash';
import type { JobDispatcher } from './dispatcher';
import type { Job } from './types';

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
const QSTASH_RETRIES = 3;

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
