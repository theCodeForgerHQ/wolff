import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { createPrisma, withTenantGuard } from '@wolff/database';
import { writeOutboxEvent } from '@wolff/core/outbox';
import { recordProviderEvent } from '@wolff/core/payments';
import {
  BullMQDispatcher,
  SCHEDULES,
  createJobQueue,
  createRedis,
  drainJobs,
  registerSchedulers,
  startJobWorker,
  startOutboxRelay,
} from './bullmq';
import { relayOutboxToJobs } from './relay';
import { TestRedis } from './testing/redis';
import type { Job, JobContext } from './types';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('BullMQ runtime (Postgres + Redis container)', () => {
  const base = createPrisma(url);
  const db = withTenantGuard(base, { mode: 'throw' });
  const run = randomUUID().replace(/-/g, '');
  let redis: TestRedis;
  let workspaceId = '';
  let clientId = '';
  let n = 0;

  let queueName = '';
  let connection: Redis;
  let queue: Queue;
  let dispatcher: BullMQDispatcher;
  let worker: Worker | null = null;
  let emailsSent = 0;
  let emailFails = false;
  let ctx: JobContext;

  const until = async (check: () => Promise<boolean>, what: string, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${what}`);
  };
  const startWorker = () =>
    (worker = startJobWorker({
      connection: createRedis(redis.url),
      ctx,
      queueName,
      delayScale: 0.0001,
    }));
  // Relay only the events this suite wrote: other suites share the outbox table.
  const mine: string[] = [];
  const relay = (target = dispatcher) =>
    relayOutboxToJobs(db, target, { ids: mine, now: new Date(Date.now() + 10 * 60_000) });
  const emailEvent = async () => {
    const id = randomUUID();
    await base.scheduledEmail.create({
      data: {
        id,
        workspaceId,
        type: 'test',
        entityType: 'invoice',
        entityId: id,
        recipientEmail: 'asha@example.test',
        subject: 'Hello',
        body: '<p>Hello</p>',
        scheduledFor: new Date(),
      },
    });
    const event = await writeOutboxEvent(db, {
      workspaceId,
      type: 'email.send',
      aggregateType: 'scheduled_email',
      aggregateId: id,
      payload: { scheduledEmailId: id, workspaceId },
    });
    mine.push(event.id);
    return { emailId: id, outboxId: event.id };
  };
  const outboxStatus = async (id: string) =>
    (await base.outboxEvent.findUniqueOrThrow({ where: { id } })).status;

  beforeAll(async () => {
    redis = await TestRedis.start();
    const workspace = await base.workspace.create({
      data: {
        name: 'BullMQ Workspace',
        slug: `bullmq-${run}`,
        clients: { create: { name: 'Asha', email: `asha-${run}@example.test` } },
      },
      include: { clients: true },
    });
    workspaceId = workspace.id;
    clientId = workspace.clients[0]!.id;
  }, 120_000);

  beforeEach(() => {
    queueName = `test-${run}-${++n}`;
    connection = createRedis(redis.url);
    queue = createJobQueue(connection, queueName);
    dispatcher = new BullMQDispatcher(queue, 750);
    mine.length = 0;
    mine.push(randomUUID());
    emailsSent = 0;
    emailFails = false;
    ctx = {
      db,
      dispatch: (job) => dispatcher.dispatch(job),
      email: {
        send: async () => {
          if (emailFails) throw new Error('Resend answered 503');
          emailsSent += 1;
        },
      },
      webhooks: { post: async () => ({ status: 200, body: '' }) },
      pdf: { render: async () => new Uint8Array() },
      storage: { put: async () => {} },
      appUrl: 'https://app.example.test',
      requireHttpsWebhooks: true,
      now: () => new Date(),
    };
  });

  afterEach(async () => {
    // A test that failed half way may have left Redis stopped.
    if (!redis.running) await redis.start();
    await worker?.close().catch(() => {});
    worker = null;
    await queue.close().catch(() => {});
    connection.disconnect();
    const where = { workspaceId };
    await base.outboxEvent.deleteMany({
      where: { OR: [where, { payload: { path: ['run'], equals: run } }] },
    });
    await base.providerWebhookEvent.deleteMany({
      where: { eventId: { startsWith: `evt_${run}` } },
    });
    await base.scheduledEmail.deleteMany({ where });
    await base.invoiceEvent.deleteMany({ where: { invoice: where } });
    await base.payment.deleteMany({ where });
    await base.invoice.deleteMany({ where });
  });

  afterAll(async () => {
    await base.workspace.deleteMany({ where: { id: workspaceId } });
    await base.$disconnect();
    await redis.kill();
  });

  it('works an outbox event off through the queue and marks it done', async () => {
    const { emailId, outboxId } = await emailEvent();
    startWorker();

    expect(await relay()).toEqual({ enqueued: 1, failed: 0 });

    await until(
      async () => (await outboxStatus(outboxId)) === 'done',
      'the outbox event to be done'
    );
    expect(emailsSent).toBe(1);
    const email = await base.scheduledEmail.findUniqueOrThrow({ where: { id: emailId } });
    expect(email.status).toBe('sent');
  });

  it('queues a job once when it is dispatched twice with the same id', async () => {
    const job: Job = { type: 'outbox.sweep', payload: {}, jobId: 'outbox:same-id' };

    await dispatcher.dispatch(job);
    await dispatcher.dispatch(job);

    expect(await queue.getJobCounts('waiting')).toEqual({ waiting: 1 });
  });

  it('retries a failing job up to its attempts, then records the failure for good', async () => {
    const { emailId, outboxId } = await emailEvent();
    emailFails = true;
    startWorker();

    await relay();

    await until(
      async () => (await outboxStatus(outboxId)) === 'failed',
      'the job to exhaust its retries'
    );
    const email = await base.scheduledEmail.findUniqueOrThrow({ where: { id: emailId } });
    expect(email).toMatchObject({ status: 'failed', retryCount: 5 });
    const event = await base.outboxEvent.findUniqueOrThrow({ where: { id: outboxId } });
    expect(event.lastError).toBe('Resend answered 503');
  });

  it('registers the repeating jobs of the spec, and only once', async () => {
    await registerSchedulers(queue);
    await registerSchedulers(queue);

    const schedulers = await queue.getJobSchedulers();
    expect(
      schedulers.map((s) => [s.key, s.name, s.pattern ?? s.every, s.tz ?? null]).sort()
    ).toEqual(
      [
        ['automations', 'automations.tick', 60_000, null],
        ['outbox-sweep', 'outbox.sweep', 300_000, null],
        ['overdue', 'invoices.mark_overdue', '15 0 * * *', 'UTC'],
        ['recurring', 'recurring.generate', '0 * * * *', 'UTC'],
        ['reminders', 'reminders.scan', '0 3 * * *', 'UTC'],
      ].sort()
    );
    expect(Object.keys(SCHEDULES)).toHaveLength(5);
  });

  describe('when Redis is lost', () => {
    const paymentEvent = async () => {
      const intent = `pi_${run}_${++n}`;
      const invoice = await base.invoice.create({
        data: {
          workspaceId,
          clientId,
          invoiceNumber: `B-${run.slice(0, 6)}-${n}`,
          status: 'sent',
          dueDate: new Date('2026-12-01T00:00:00Z'),
          total: 90,
          amountDue: 90,
          payments: {
            create: {
              workspaceId,
              amount: 90,
              paymentMethod: 'card',
              stripePaymentIntentId: intent,
            },
          },
        },
      });
      // What the webhook endpoint does once the signature is verified.
      const recorded = await recordProviderEvent(db, {
        provider: 'stripe',
        eventId: `evt_${run}_${n}`,
        type: 'payment_intent.succeeded',
        payload: {
          type: 'payment_intent.succeeded',
          data: { object: { id: intent, latest_charge: null } },
        },
        outbox: true,
      });
      const outbox = await base.outboxEvent.findFirstOrThrow({
        where: { aggregateId: recorded.id },
      });
      mine.push(outbox.id);
      const status = async () =>
        (await base.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status;
      return { eventRowId: recorded.id, outboxId: outbox.id, status };
    };

    it('reconciles an event committed while Redis was down, once Redis is back', async () => {
      // The webhook was acknowledged: event and outbox row are committed.
      const event = await paymentEvent();
      await redis.kill();

      // The relay cannot enqueue: it gives up after its timeout and the event
      // stays pending with the reason on it.
      expect(await relay()).toEqual({ enqueued: 0, failed: 1 });
      const pending = await base.outboxEvent.findUniqueOrThrow({ where: { id: event.outboxId } });
      expect(pending).toMatchObject({ status: 'pending', attempts: 1 });
      expect(pending.lastError).toMatch(/did not accept a job/);
      expect(await event.status()).toBe('sent');

      // Redis returns, empty. The relay keeps running, as it does in the
      // worker; the job reaches the queue and the worker reconciles the event.
      await redis.start();
      startWorker();
      await until(async () => {
        await relay();
        return (await event.status()) === 'paid';
      }, 'the invoice to be paid');
      await until(
        async () => (await outboxStatus(event.outboxId)) === 'done',
        'the outbox event to be done'
      );
      const row = await base.providerWebhookEvent.findUniqueOrThrow({
        where: { id: event.eventRowId },
      });
      expect(row.status).toBe('processed');
    }, 120_000);

    it('reconciles an event whose job was lost with Redis, through the sweeper', async () => {
      const event = await paymentEvent();
      // Enqueued, but no worker has taken it yet.
      expect((await relay()).enqueued).toBe(1);
      expect(await outboxStatus(event.outboxId)).toBe('enqueued');

      // Redis is replaced by an empty one: the job is gone, the row still says enqueued.
      await redis.kill();
      await redis.start();
      startWorker();
      expect((await relay()).enqueued).toBe(0);
      expect(await event.status()).toBe('sent');

      // Ten minutes later the sweeper puts it back and the relay enqueues it again.
      await base.outboxEvent.update({
        where: { id: event.outboxId },
        data: { enqueuedAt: new Date(Date.now() - 11 * 60_000) },
      });
      // The connection may still be reconnecting to the new Redis.
      await until(
        () =>
          dispatcher.dispatch({ type: 'outbox.sweep', payload: {}, jobId: `sweep:${n}` }).then(
            () => true,
            () => false
          ),
        'the sweep job to be accepted'
      );
      await until(
        async () => (await outboxStatus(event.outboxId)) === 'pending',
        'the sweeper to requeue'
      );
      await until(async () => (await relay()).enqueued === 1, 'the relay to enqueue again');

      await until(async () => (await event.status()) === 'paid', 'the invoice to be paid');
      expect(await outboxStatus(event.outboxId)).toBe('done');
    }, 120_000);
  });

  it('relays on a timer', async () => {
    const { outboxId } = await emailEvent();
    const errors: unknown[] = [];
    startWorker();
    const handle = startOutboxRelay({
      db,
      dispatcher,
      intervalMs: 50,
      relay: { ids: mine },
      onError: (e) => errors.push(e),
    });

    await until(async () => (await outboxStatus(outboxId)) === 'done', 'the relay loop to deliver');
    await handle.stop();

    expect(emailsSent).toBe(1);
    expect(errors).toEqual([]);
  });

  it('drains: does the scheduled work, relays, works the queue dry and stops', async () => {
    const { outboxId } = await emailEvent();
    const late = await base.invoice.create({
      data: {
        workspaceId,
        clientId,
        invoiceNumber: `D-${run.slice(0, 6)}-${++n}`,
        status: 'sent',
        dueDate: new Date('2020-01-01T00:00:00Z'),
        total: 10,
        amountDue: 10,
      },
    });

    const summary = await drainJobs({
      connection: createRedis(redis.url),
      ctx,
      queueName,
      maxMs: 30_000,
      scheduled: ['invoices.mark_overdue'],
      relay: { ids: mine },
    });

    expect(summary).toMatchObject({ remaining: 0, failed: 0, timedOut: false });
    expect(summary.completed).toBeGreaterThanOrEqual(2);
    expect(await outboxStatus(outboxId)).toBe('done');
    expect((await base.invoice.findUniqueOrThrow({ where: { id: late.id } })).status).toBe(
      'overdue'
    );
  }, 60_000);
});
