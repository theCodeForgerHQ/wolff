import type { Prisma } from '@wolff/database';
import type { Db } from '../context';
import { logger } from '../logger';
import { writeOutboxEvent } from '../outbox';
import { applyRazorpayEvent } from './apply-razorpay-event';
import { applyStripeEvent } from './apply-stripe-event';

/**
 * Inbound provider webhooks, without losing or double-processing one.
 * 
 *
 * `recordProviderEvent` stores a verified event and its reconcile job in one
 * transaction, so an event that was acknowledged is always owed a job.
 * `processProviderEvent` applies it and marks it processed in one transaction
 * too, holding a lock on the event row, so two deliveries of the same event
 * (a provider retry, or the old and the new endpoint during the cutover)
 * apply it once.
 *
 * Events arrive before any workspace is known, so this module works on the
 * unscoped client; it is one of the tenant guard's documented exemptions.
 */
export type PaymentProvider = 'stripe' | 'razorpay';

export const RECONCILE_EVENT_TYPE = 'payment.reconcile';
export const PROVIDER_EVENT_AGGREGATE = 'provider_webhook_event';

export interface RecordProviderEventInput {
  provider: PaymentProvider;
  /**
   * The workspace whose endpoint and secret verified the event. Required for
   * Razorpay: the event may only touch that workspace's payments.
   */
  workspaceId?: string;
  /** The provider's id for the event; the idempotency key. */
  eventId: string;
  type: string;
  payload: unknown;
  /**
   * Queue a reconcile job. False only for a caller that processes the event
   * itself right away (the Next.js route that predates the API).
   */
  outbox: boolean;
  traceId?: string;
}

export type RecordOutcome =
  /** First time this event is seen. */
  | 'recorded'
  /** Seen before and not processed; it needs processing (a job was queued if asked for). */
  | 'redriven'
  /** Seen before; already processed, or a job for it is already waiting. */
  | 'duplicate';

export async function recordProviderEvent(
  db: Db,
  input: RecordProviderEventInput
): Promise<{ outcome: RecordOutcome; id: string; outboxEventId?: string }> {
  if (input.provider === 'razorpay' && !input.workspaceId) {
    throw new Error('A Razorpay event must be recorded with the workspace that verified it');
  }
  return db.$unscoped.$transaction(async (tx) => {
    const inserted = await tx.providerWebhookEvent.createMany({
      data: {
        provider: input.provider,
        workspaceId: input.workspaceId ?? null,
        eventId: input.eventId,
        type: input.type.slice(0, 100),
        payload: input.payload as Prisma.InputJsonValue,
      },
      skipDuplicates: true,
    });

    // Lock the row so concurrent deliveries decide about the job one at a time.
    const [row] = await tx.$queryRaw<{ id: string; status: string; workspace_id: string | null }[]>`
      SELECT id, status::text, workspace_id FROM provider_webhook_events
      WHERE provider = ${input.provider}::payment_provider AND event_id = ${input.eventId}
      FOR UPDATE`;
    if (!row) throw new Error('provider event row missing after insert');
    // The same event id already stored for another workspace: never let this
    // delivery re-drive (or take over) that workspace's event.
    if ((row.workspace_id ?? null) !== (input.workspaceId ?? null)) {
      return { outcome: 'duplicate' as const, id: row.id };
    }

    const queue = () =>
      writeOutboxEvent(tx, {
        workspaceId: null,
        type: RECONCILE_EVENT_TYPE,
        aggregateType: PROVIDER_EVENT_AGGREGATE,
        aggregateId: row.id,
        payload: { eventRowId: row.id },
        traceId: input.traceId,
      });

    if (inserted.count === 1) {
      const queued = input.outbox ? await queue() : undefined;
      return { outcome: 'recorded' as const, id: row.id, outboxEventId: queued?.id };
    }
    if (row.status === 'processed') return { outcome: 'duplicate' as const, id: row.id };
    if (!input.outbox) return { outcome: 'redriven' as const, id: row.id };

    const waiting = await tx.outboxEvent.count({
      where: {
        aggregateType: PROVIDER_EVENT_AGGREGATE,
        aggregateId: row.id,
        status: { in: ['pending', 'enqueued'] },
      },
    });
    if (waiting > 0) return { outcome: 'duplicate' as const, id: row.id };
    const queued = await queue();
    return { outcome: 'redriven' as const, id: row.id, outboxEventId: queued.id };
  });
}

export type ProcessOutcome = 'processed' | 'already_processed' | 'not_found' | 'dead_lettered';

/**
 * Failed attempts after which an event is dead-lettered: marked `failed`,
 * logged, and no longer re-driven by retries or the sweeper. Someone has to
 * look at it (its last error is on the row).
 */
export const MAX_PROCESSING_ATTEMPTS = 10;

/**
 * Applies a recorded event. Throws when applying fails; nothing of the event
 * is applied in that case, the error is kept on the row and the event stays
 * `received` so that a retry or a redelivery processes it.
 */
export async function processProviderEvent(db: Db, eventRowId: string): Promise<ProcessOutcome> {
  try {
    return await db.$unscoped.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<
        { id: string; status: string; provider: string; workspace_id: string | null }[]
      >`
        SELECT id, status::text, provider::text, workspace_id FROM provider_webhook_events
        WHERE id = ${eventRowId} FOR UPDATE`;
      if (!row) return 'not_found';
      if (row.status === 'processed') return 'already_processed';
      if (row.status === 'failed') return 'dead_lettered';

      const event = await tx.providerWebhookEvent.findUniqueOrThrow({
        where: { id: row.id },
        select: { payload: true },
      });
      if (row.provider === 'stripe') await applyStripeEvent(tx, event.payload);
      else if (row.provider === 'razorpay') {
        if (!row.workspace_id) throw new Error('Razorpay event has no workspace');
        await applyRazorpayEvent(tx, event.payload, { workspaceId: row.workspace_id });
      } else throw new Error(`No handler for provider ${row.provider}`);

      await tx.providerWebhookEvent.update({
        where: { id: row.id },
        data: { status: 'processed', processedAt: new Date(), lastError: null },
      });
      return 'processed';
    });
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
    const [counted] = await db.$unscoped.$queryRaw<{ status: string; attempts: number }[]>`
      UPDATE provider_webhook_events
      SET attempts = attempts + 1,
          last_error = ${message},
          status = CASE WHEN attempts + 1 >= ${MAX_PROCESSING_ATTEMPTS}
                        THEN 'failed'::webhook_event_status ELSE status END
      WHERE id = ${eventRowId} AND status = 'received'
      RETURNING status::text, attempts`.catch(() => []);
    if (counted?.status === 'failed') {
      logger.error(
        { eventRowId, attempts: counted.attempts, lastError: message },
        'Provider webhook event dead-lettered after repeated failures'
      );
    }
    throw error;
  }
}

/**
 * The sweeper's view: events that were acknowledged more than `olderThanMs`
 * ago, are still unprocessed and have no job waiting. Each gets a new job.
 */
export async function redriveStaleProviderEvents(
  db: Db,
  options: { now?: Date; olderThanMs?: number } = {}
): Promise<number> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - (options.olderThanMs ?? 10 * 60_000));

  const stale = await db.$unscoped.$queryRaw<{ id: string }[]>`
    SELECT e.id FROM provider_webhook_events e
    WHERE e.status = 'received' AND e.received_at < ${cutoff}
      AND NOT EXISTS (
        SELECT 1 FROM outbox_events o
        WHERE o.aggregate_type = ${PROVIDER_EVENT_AGGREGATE} AND o.aggregate_id = e.id
          AND o.status IN ('pending', 'enqueued'))
    LIMIT 500`;

  for (const { id } of stale) {
    await writeOutboxEvent(db.$unscoped, {
      workspaceId: null,
      type: RECONCILE_EVENT_TYPE,
      aggregateType: PROVIDER_EVENT_AGGREGATE,
      aggregateId: id,
      payload: { eventRowId: id },
    });
  }
  return stale.length;
}
