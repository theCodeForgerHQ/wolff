import { Prisma } from '@wolff/database';
import type { Db, DbOrTx } from '../context';

/**
 * Transactional outbox. A business change and the event that
 * announces it are written in one transaction; a relay moves events to the
 * job queue afterwards. The row, not the queue, is the record: an event is
 * `done` only when its job finished, so a lost queue is refilled from here.
 *
 * The relay and the sweeper work across workspaces and are one of the tenant
 * guard's documented exemptions, hence `$unscoped`.
 */
export interface OutboxEventInput {
  /** Null only when the workspace is not known yet (an unreconciled inbound webhook). */
  workspaceId: string | null;
  type: string;
  aggregateType: string;
  aggregateId: string;
  /** Ids only; no personal data goes to the queue. */
  payload?: Prisma.InputJsonObject;
  traceId?: string;
  availableAt?: Date;
}

export interface RelayedOutboxEvent {
  id: string;
  workspaceId: string | null;
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: Prisma.JsonValue;
  traceId: string | null;
  attempts: number;
}

const STALE_AFTER_MS = 10 * 60_000;
const MAX_ERROR_LENGTH = 2_000;

/** Call with the transaction client of the change the event belongs to. */
export async function writeOutboxEvent(
  tx: DbOrTx,
  input: OutboxEventInput
): Promise<{ id: string }> {
  return tx.outboxEvent.create({
    data: {
      workspaceId: input.workspaceId,
      type: input.type,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      payload: input.payload ?? {},
      traceId: input.traceId,
      availableAt: input.availableAt,
    },
    select: { id: true },
  });
}

export interface RelayOptions {
  limit?: number;
  now?: Date;
  /** Restrict the batch to these event types. */
  types?: string[];
}

/**
 * Hands due `pending` events to `enqueue` and marks those that were accepted
 * `enqueued`. Rows are locked with SKIP LOCKED for the length of the batch,
 * so relays running side by side take different rows. If the process dies
 * after enqueueing and before the commit, the rows stay `pending` and are
 * enqueued again; the queue dedupes on the job id `outbox:<id>`.
 */
export async function relayOutboxBatch(
  db: Db,
  enqueue: (event: RelayedOutboxEvent) => Promise<void>,
  options: RelayOptions = {}
): Promise<{ enqueued: number; failed: number }> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 100;
  const typeFilter = options.types?.length
    ? Prisma.sql`AND type IN (${Prisma.join(options.types)})`
    : Prisma.empty;

  return db.$unscoped.$transaction(async (tx) => {
    const batch = await tx.$queryRaw<RelayedOutboxEvent[]>`
      SELECT id, workspace_id AS "workspaceId", type, aggregate_type AS "aggregateType",
             aggregate_id AS "aggregateId", payload, trace_id AS "traceId", attempts
      FROM outbox_events
      WHERE status = 'pending' AND available_at <= ${now} ${typeFilter}
      ORDER BY available_at, created_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED`;

    let enqueued = 0;
    let failed = 0;
    for (const event of batch) {
      try {
        await enqueue(event);
        await tx.outboxEvent.update({
          where: { id: event.id },
          data: { status: 'enqueued', enqueuedAt: now, lastError: null },
        });
        enqueued += 1;
      } catch (error) {
        await tx.outboxEvent.update({
          where: { id: event.id },
          data: { attempts: { increment: 1 }, lastError: describe(error) },
        });
        failed += 1;
      }
    }
    return { enqueued, failed };
  });
}

/** The job for this event finished. */
export async function completeOutboxEvent(db: Db, id: string, now = new Date()): Promise<void> {
  await db.$unscoped.outboxEvent.updateMany({
    where: { id, status: { not: 'done' } },
    data: { status: 'done', doneAt: now, lastError: null },
  });
}

/** The job for this event failed for good. A finished event stays finished. */
export async function failOutboxEvent(db: Db, id: string, error: unknown): Promise<void> {
  await db.$unscoped.outboxEvent.updateMany({
    where: { id, status: { not: 'done' } },
    data: { status: 'failed', attempts: { increment: 1 }, lastError: describe(error) },
  });
}

export interface SweepOptions {
  now?: Date;
  staleAfterMs?: number;
  types?: string[];
  /** Return false for an event whose job is still alive in the queue. */
  isAbandoned?: (id: string) => Promise<boolean>;
}

/**
 * The sweeper: events that were enqueued long ago and never finished go back
 * to `pending`, so the relay enqueues them again. This is what recovers from
 * a queue that lost its contents.
 */
export async function requeueStaleOutboxEvents(
  db: Db,
  options: SweepOptions = {}
): Promise<number> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - (options.staleAfterMs ?? STALE_AFTER_MS));

  const stale = await db.$unscoped.outboxEvent.findMany({
    where: {
      status: 'enqueued',
      enqueuedAt: { lt: cutoff },
      ...(options.types?.length ? { type: { in: options.types } } : {}),
    },
    select: { id: true },
    take: 500,
  });

  let requeued = 0;
  for (const { id } of stale) {
    if (options.isAbandoned && !(await options.isAbandoned(id))) continue;
    const result = await db.$unscoped.outboxEvent.updateMany({
      where: { id, status: 'enqueued' },
      data: { status: 'pending', enqueuedAt: null },
    });
    requeued += result.count;
  }
  return requeued;
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_LENGTH);
}
