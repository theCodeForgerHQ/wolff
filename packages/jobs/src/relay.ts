import { OutboxRelayAborted, relayOutboxBatch, type RelayOptions } from '@wolff/core/outbox';
import type { Db } from '@wolff/core/context';
import type { JobDispatcher } from './dispatcher';
import { jobForOutboxEvent } from './routing';

/**
 * One pass of the outbox relay: every due event becomes a job on the
 * dispatcher. An event no job handles is left pending with the reason on it,
 * where it is visible, instead of being marked done. If the dispatcher itself
 * fails, the pass ends there and the remaining events wait for the next one.
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
      try {
        await dispatcher.dispatch(job);
      } catch (error) {
        // The queue did not take it. That is about the queue, not this event.
        throw new OutboxRelayAborted(error);
      }
    },
    options
  );
}
