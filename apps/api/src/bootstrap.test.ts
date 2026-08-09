import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { recordProviderEvent } from '@wolff/core/payments';
import type { Job, JobDispatcher } from '@wolff/jobs';
import { createOutboxPush } from './bootstrap';
import { TEST_DATABASE_URL, testDb } from './testing/harness';

describe.skipIf(!TEST_DATABASE_URL)('outbox push after a request commits (Postgres)', () => {
  const { base, db } = testDb();
  const run = randomUUID().replace(/-/g, '');

  afterAll(async () => {
    const events = await base.providerWebhookEvent.findMany({
      where: { eventId: { startsWith: `evt_${run}` } },
      select: { id: true },
    });
    const ids = events.map((e) => e.id);
    await base.outboxEvent.deleteMany({ where: { aggregateId: { in: ids } } });
    await base.providerWebhookEvent.deleteMany({ where: { id: { in: ids } } });
    await base.$disconnect();
  });

  it('queues a webhook event as its reconcile job, under the id the relay uses', async () => {
    const jobs: Job[] = [];
    const dispatcher: JobDispatcher = { dispatch: async (job) => void jobs.push(job) };
    const recorded = await recordProviderEvent(db, {
      provider: 'stripe',
      eventId: `evt_${run}_1`,
      type: 'payment_intent.succeeded',
      payload: { id: `evt_${run}_1` },
      outbox: true,
    });

    await createOutboxPush(db, dispatcher)([recorded.outboxEventId!]);

    expect(jobs).toEqual([
      expect.objectContaining({
        type: 'payments.reconcile',
        jobId: `outbox:${recorded.outboxEventId}`,
        payload: { eventRowId: recorded.id },
      }),
    ]);
    // Marked as handed over, so the relay does not queue it a second time.
    const row = await base.outboxEvent.findUniqueOrThrow({
      where: { id: recorded.outboxEventId! },
    });
    expect(row.status).toBe('enqueued');
  });
});
