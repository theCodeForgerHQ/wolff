import { Prisma } from '@wolff/database';
import type { Db } from '../context';

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

/** Any client or transaction client, guarded or not, that can insert an outbox row. */
export interface OutboxWriter {
  outboxEvent: {
    create(args: {
      data: Prisma.OutboxEventUncheckedCreateInput;
      select: { id: true };
    }): PromiseLike<{ id: string }>;
  };
}

/** Call with the transaction client of the change the event belongs to. */
export async function writeOutboxEvent(
  tx: OutboxWriter,
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
  /** Restrict the batch to these events, e.g. the ones a request just wrote. */
  ids?: string[];
}

/**
 * Thrown by the enqueue callback when the queue itself cannot be reached.
 * The relay records it on the event and ends the pass: trying the rest of
 * the batch would only repeat the same timeout inside one transaction.
 */
export class OutboxRelayAborted extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'OutboxRelayAborted';
  }
}

const MAX_RETRY_DELAY_MS = 5 * 60_000;

/** 2 s, 4 s, 8 s … capped at 5 minutes. */
function retryDelayMs(attemptsAfterThisOne: number): number {
  return Math.min(1_000 * 2 ** attemptsAfterThisOne, MAX_RETRY_DELAY_MS);
}

/**
 * Hands due `pending` events to `enqueue` and marks those that were accepted
 * `enqueued`. A failed one stays pending and is retried after a growing delay.
 * Rows are locked with SKIP LOCKED for the length of the batch,
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
  const idFilter = options.ids?.length
    ? Prisma.sql`AND id IN (${Prisma.join(options.ids)})`
    : Prisma.empty;

  return db.$unscoped.$transaction(async (tx) => {
    const batch = await tx.$queryRaw<RelayedOutboxEvent[]>`
      SELECT id, workspace_id AS "workspaceId", type, aggregate_type AS "aggregateType",
             aggregate_id AS "aggregateId", payload, trace_id AS "traceId", attempts
      FROM outbox_events
      WHERE status = 'pending' AND available_at <= ${now} ${typeFilter} ${idFilter}
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
        // Stays pending, and is not looked at again until the delay has passed,
        // so an event that cannot be enqueued does not spin every pass.
        await tx.outboxEvent.update({
          where: { id: event.id },
          data: {
            attempts: { increment: 1 },
            lastError: describe(error),
            availableAt: new Date(now.getTime() + retryDelayMs(event.attempts + 1)),
          },
        });
        failed += 1;
        if (error instanceof OutboxRelayAborted) break;
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

/** Documents the AI service indexes; matches its source types. */
export type AiSourceType = 'quote' | 'invoice' | 'contract' | 'client_note';

/**
 * Asks the AI service to (re)index a document after it changed. Written in
 * the change's transaction like any outbox event; the `ai.index` job sends
 * it on. Writes that skip this are caught by the nightly `ai.sweep`.
 */
export async function requestAiIndexing(
  tx: OutboxWriter,
  input: { workspaceId: string; sourceType: AiSourceType; sourceId: string }
): Promise<{ id: string }> {
  return writeOutboxEvent(tx, {
    workspaceId: input.workspaceId,
    type: 'ai.index',
    aggregateType: input.sourceType,
    aggregateId: input.sourceId,
    payload: { sourceType: input.sourceType, sourceId: input.sourceId },
  });
}

/**
 * Asks for a document's PDF after it was sent or issued. Written in the
 * status change's transaction; the `pdf.render` job renders the public page
 * and stores it under a key derived from the document's version, and skips
 * a version it already stored, so a repeated request renders once.
 */
export async function requestPdfRender(
  tx: OutboxWriter,
  input: { workspaceId: string; documentType: 'invoice' | 'quote'; documentId: string }
): Promise<{ id: string }> {
  return writeOutboxEvent(tx, {
    workspaceId: input.workspaceId,
    type: 'pdf.render',
    aggregateType: input.documentType,
    aggregateId: input.documentId,
    payload: { documentType: input.documentType, documentId: input.documentId },
  });
}
