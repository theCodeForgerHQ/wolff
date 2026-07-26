import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createPrisma, withTenantGuard } from '@wolff/database';
import {
  completeOutboxEvent,
  failOutboxEvent,
  relayOutboxBatch,
  requeueStaleOutboxEvents,
  writeOutboxEvent,
} from './index';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('outbox (Postgres)', () => {
  const base = createPrisma(url);
  const db = withTenantGuard(base, { mode: 'throw' });
  // Each test uses its own event type, so parallel suites and leftovers from
  // other runs never enter its batches.
  let type = '';
  const newType = () => (type = `test.${randomUUID()}`);
  const write = (aggregateId: string, extra: { availableAt?: Date } = {}) =>
    writeOutboxEvent(db, {
      workspaceId: null,
      type,
      aggregateType: 'test',
      aggregateId,
      payload: { aggregateId },
      ...extra,
    });
  const rows = () =>
    base.outboxEvent.findMany({ where: { type }, orderBy: { aggregateId: 'asc' } });

  afterEach(async () => {
    await base.outboxEvent.deleteMany({ where: { type } });
  });

  afterAll(async () => {
    await base.$disconnect();
  });

  it('is written with the business change, or not at all', async () => {
    newType();

    await expect(
      db.$transaction(async (tx) => {
        await writeOutboxEvent(tx, {
          workspaceId: null,
          type,
          aggregateType: 'test',
          aggregateId: 'rolled-back',
        });
        throw new Error('business change failed');
      })
    ).rejects.toThrow('business change failed');

    expect(await rows()).toEqual([]);
  });

  it('relays pending events once and marks them enqueued', async () => {
    newType();
    await write('a');
    await write('b');
    const enqueued: string[] = [];
    const enqueue = async (event: { aggregateId: string }) => void enqueued.push(event.aggregateId);

    const first = await relayOutboxBatch(db, enqueue, { types: [type] });
    const second = await relayOutboxBatch(db, enqueue, { types: [type] });

    expect(first).toEqual({ enqueued: 2, failed: 0 });
    expect(second).toEqual({ enqueued: 0, failed: 0 });
    expect(enqueued.sort()).toEqual(['a', 'b']);
    expect((await rows()).map((r) => [r.status, r.enqueuedAt !== null])).toEqual([
      ['enqueued', true],
      ['enqueued', true],
    ]);
  });

  it('keeps an event pending, with the error, when the queue is down', async () => {
    newType();
    await write('a');

    const result = await relayOutboxBatch(
      db,
      async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:6379');
      },
      { types: [type] }
    );

    expect(result).toEqual({ enqueued: 0, failed: 1 });
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'pending', attempts: 1, enqueuedAt: null });
    expect(row!.lastError).toContain('ECONNREFUSED');
  });

  it('does not hand the same event to two relays running at once', async () => {
    newType();
    for (const id of ['a', 'b', 'c', 'd']) await write(id);
    const enqueued: string[] = [];
    const slow = async (event: { aggregateId: string }) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      enqueued.push(event.aggregateId);
    };

    const results = await Promise.all([
      relayOutboxBatch(db, slow, { types: [type] }),
      relayOutboxBatch(db, slow, { types: [type] }),
    ]);

    expect(results[0]!.enqueued + results[1]!.enqueued).toBe(4);
    expect(enqueued.sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('leaves events that are not due yet', async () => {
    newType();
    const now = new Date('2026-09-30T12:00:00Z');
    await write('later', { availableAt: new Date(now.getTime() + 60_000) });

    expect(await relayOutboxBatch(db, async () => {}, { types: [type], now })).toEqual({
      enqueued: 0,
      failed: 0,
    });
  });

  it('marks an event done, and a finished event cannot be failed afterwards', async () => {
    newType();
    const { id } = await write('a');
    await relayOutboxBatch(db, async () => {}, { types: [type] });

    await completeOutboxEvent(db, id);
    await failOutboxEvent(db, id, 'late failure');

    const [row] = await rows();
    expect(row).toMatchObject({ status: 'done', lastError: null });
    expect(row!.doneAt).not.toBeNull();
  });

  it('puts events stuck in enqueued for 10 minutes back to pending', async () => {
    newType();
    const stuck = await write('stuck');
    const fresh = await write('fresh');
    await relayOutboxBatch(db, async () => {}, { types: [type] });
    const now = new Date();
    await base.outboxEvent.update({
      where: { id: stuck.id },
      data: { enqueuedAt: new Date(now.getTime() - 11 * 60_000) },
    });

    const requeued = await requeueStaleOutboxEvents(db, { types: [type], now });

    expect(requeued).toBe(1);
    const byId = new Map((await rows()).map((r) => [r.id, r.status]));
    expect(byId.get(stuck.id)).toBe('pending');
    expect(byId.get(fresh.id)).toBe('enqueued');
  });
});
