import { relayOutboxBatch, type RelayOptions } from '@wolff/core/outbox';
import type { Db } from '@wolff/core/context';
import type { JobDispatcher } from './dispatcher';
import { jobForOutboxEvent } from './routing';

/**
 * One pass of the outbox relay: every due event becomes a job on the
 * dispatcher. An event no job handles is left pending with the reason on it,
 * where it is visible, instead of being marked done.
 */
export async function relayOutboxToJobs(
  db: Db,
  dispatcher: JobDispatcher,
  options: RelayOptions = {}
): Promise<{ enqueued: number; failed: number }> {
  return relayOutboxBatch(
    db,
    async (event) => {
      const job = jobForOutboxEvent(event);
      if (!job) throw new Error(`No job handles outbox event type "${event.type}"`);
      await dispatcher.dispatch(job);
    },
    options
  );
}
