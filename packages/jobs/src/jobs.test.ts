import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma, withTenantGuard } from '@wolff/database';
import { recordProviderEvent } from '@wolff/core/payments';
import { approveRun } from '@wolff/core/automations';
import {
  createWebhookEndpoint,
  verifyWebhookSignature,
  webhookHeaderNames,
} from '@wolff/core/webhooks';
import {
  InlineDispatcher,
  InvalidJobError,
  RETRY_POLICIES,
  handleExhaustedJob,
  jobForOutboxEvent,
  pdfKey,
  relayOutboxToJobs,
  runJob,
  type EmailMessage,
  type Job,
  type JobContext,
} from './index';

describe('jobForOutboxEvent', () => {
  const event = (type: string, payload: unknown, workspaceId: string | null = 'ws-1') => ({
    id: 'evt-1',
    workspaceId,
    type,
    aggregateType: 'x',
    aggregateId: 'y',
    payload: payload as never,
    traceId: 'trace-1',
    attempts: 0,
  });

  it('gives every job the id `outbox:<event id>` and carries the trace', () => {
    expect(jobForOutboxEvent(event('payment.reconcile', { eventRowId: 'row-1' }, null))).toEqual({
      type: 'payments.reconcile',
      payload: { eventRowId: 'row-1' },
      jobId: 'outbox:evt-1',
      outboxEventId: 'evt-1',
      traceId: 'trace-1',
    });
  });

  it('routes a domain event to the webhook fan-out', () => {
    expect(jobForOutboxEvent(event('invoice.paid', { invoiceId: 'inv-1' }))).toMatchObject({
      type: 'webhooks.fanout',
      payload: { outboxEventId: 'evt-1' },
    });
  });

  it("takes the workspace from the event row, not from the event's payload", () => {
    const job = jobForOutboxEvent(
      event('webhook.deliver', { deliveryId: 'd-1', workspaceId: 'ws-attacker' }, 'ws-1')
    );

    expect(job?.payload).toEqual({ deliveryId: 'd-1', workspaceId: 'ws-1' });
  });

  it.each([
    ['an unknown type', event('nonsense.happened', {})],
    ['a payload that does not fit the job', event('webhook.deliver', { wrong: true })],
    ['a domain event without a workspace', event('invoice.paid', {}, null)],
  ])('returns null for %s', (_name, e) => {
    expect(jobForOutboxEvent(e)).toBeNull();
  });
});

describe('retry policies', () => {
  it('retries webhook delivery 8 times, waiting 1m, 5m, 30m, 2h, 6h, 12h, 24h', () => {
    const policy = RETRY_POLICIES['webhooks.deliver'];
    const minutes = [1, 2, 3, 4, 5, 6, 7].map((made) => policy.delayMs(made) / 60_000);

    expect(policy.attempts).toBe(8);
    expect(minutes).toEqual([1, 5, 30, 120, 360, 720, 1440]);
  });

  it('backs off exponentially for payment reconcile', () => {
    const policy = RETRY_POLICIES['payments.reconcile'];

    expect(policy.attempts).toBe(5);
    expect([1, 2, 3].map(policy.delayMs)).toEqual([30_000, 60_000, 120_000]);
  });
});

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('job processors (Postgres)', () => {
  const base = createPrisma(url);
  const db = withTenantGuard(base, { mode: 'throw' });
  const run = randomUUID().replace(/-/g, '');
  const NOW = new Date('2026-10-01T04:30:00Z');
  const originalKey = process.env.ENCRYPTION_KEY;
  let workspaceId = '';
  let clientId = '';
  let n = 0;

  const emails: EmailMessage[] = [];
  const posts: { url: string; headers: Record<string, string>; body: string }[] = [];
  const stored: { key: string; bytes: number; contentType: string }[] = [];
  const rendered: string[] = [];
  let emailFails = false;
  let dispatcher: InlineDispatcher;
  let ctx: JobContext;

  // Only this suite's events: other suites write to the same outbox table.
  const mine = async () =>
    (
      await base.outboxEvent.findMany({
        where: {
          status: 'pending',
          OR: [{ workspaceId }, { payload: { path: ['run'], equals: run } }],
        },
        select: { type: true },
      })
    ).map((e) => e.type);
  const relayAndDrain = async () => {
    for (let pass = 0; pass < 10; pass++) {
      const types = [...new Set(await mine())];
      if (types.length === 0) break;
      await relayOutboxToJobs(db, dispatcher, { types, now: new Date() });
      await dispatcher.drain();
    }
  };

  const invoice = (data: Record<string, unknown> = {}) =>
    base.invoice.create({
      data: {
        workspaceId,
        clientId,
        invoiceNumber: `J-${run.slice(0, 6)}-${++n}`,
        status: 'sent',
        issueDate: new Date('2026-09-01T00:00:00Z'),
        dueDate: new Date('2026-12-01T00:00:00Z'),
        total: 250,
        amountDue: 250,
        ...data,
      } as never,
    });

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
    const workspace = await base.workspace.create({
      data: {
        name: 'Jobs Workspace',
        slug: `jobs-${run}`,
        clients: { create: { name: 'Asha', email: `asha-${run}@example.test` } },
      },
      include: { clients: true },
    });
    workspaceId = workspace.id;
    clientId = workspace.clients[0]!.id;
  });

  beforeEach(() => {
    emails.length = posts.length = stored.length = rendered.length = 0;
    emailFails = false;
    dispatcher = new InlineDispatcher((job) => runJob(ctx, job));
    ctx = {
      db,
      dispatch: (job) => dispatcher.dispatch(job),
      email: {
        send: async (message) => {
          if (emailFails) throw new Error('Resend answered 503');
          emails.push(message);
        },
      },
      webhooks: {
        post: async (target, request) => {
          posts.push({ url: target, headers: request.headers, body: request.body });
          return { status: 200, body: 'ok' };
        },
      },
      pdf: {
        render: async (target) => {
          rendered.push(target);
          return new Uint8Array([0x25, 0x50, 0x44, 0x46]);
        },
      },
      storage: {
        put: async (key, body, contentType) => {
          stored.push({ key, bytes: body.length, contentType });
        },
      },
      appUrl: 'https://app.example.test/',
      requireHttpsWebhooks: true,
      now: () => NOW,
    };
  });

  afterEach(async () => {
    const where = { workspaceId };
    await base.outboxEvent.deleteMany({
      where: { OR: [where, { payload: { path: ['run'], equals: run } }] },
    });
    await base.providerWebhookEvent.deleteMany({
      where: { eventId: { startsWith: `evt_${run}` } },
    });
    await base.webhookEndpoint.deleteMany({ where });
    await base.scheduledEmail.deleteMany({ where });
    await base.invoiceEvent.deleteMany({ where: { invoice: where } });
    await base.payment.deleteMany({ where });
    await base.invoice.updateMany({ where, data: { parentInvoiceId: null } });
    await base.invoice.deleteMany({ where });
    await base.automationRun.deleteMany({ where });
    await base.automation.deleteMany({ where });
    await base.deal.deleteMany({ where });
    await base.stage.deleteMany({ where });
    await base.pipeline.deleteMany({ where });
    await base.numberSequence.deleteMany({ where });
  });

  afterAll(async () => {
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalKey;
    await base.workspace.deleteMany({ where: { id: workspaceId } });
    await base.$disconnect();
  });

  it('takes a Stripe event from the outbox to a paid invoice, a signed webhook and a receipt', async () => {
    const created = await invoice();
    const intent = `pi_${run}_${n}`;
    await base.payment.create({
      data: {
        workspaceId,
        invoiceId: created.id,
        amount: 250,
        currency: 'usd',
        paymentMethod: 'card',
        stripePaymentIntentId: intent,
      },
    });
    const endpoint = await createWebhookEndpoint(
      { db, workspaceId },
      { url: 'https://hooks.example.com/in', events: ['invoice.paid'] },
      { requireHttps: true }
    );
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
    await base.outboxEvent.updateMany({
      where: { aggregateId: recorded.id },
      data: { payload: { eventRowId: recorded.id, run } },
    });

    await relayAndDrain();

    const paid = await base.invoice.findUniqueOrThrow({ where: { id: created.id } });
    expect(paid.status).toBe('paid');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]!.body)).toMatchObject({
      type: 'invoice.paid',
      payload: { invoiceId: created.id, workspaceId },
    });
    expect(
      verifyWebhookSignature(
        endpoint.secret,
        posts[0]!.body,
        posts[0]!.headers[webhookHeaderNames.signature]!,
        NOW
      )
    ).toBe(true);
    expect(emails.map((e) => [e.to, e.subject])).toEqual([
      [`asha-${run}@example.test`, `Payment received for invoice ${created.invoiceNumber}`],
    ]);
    expect(emails[0]!.idempotencyKey).toMatch(/^email:/);
    const left = await base.outboxEvent.findMany({
      where: { OR: [{ workspaceId }, { aggregateId: recorded.id }] },
      orderBy: { type: 'asc' },
    });
    expect(left.map((e) => [e.type, e.status])).toEqual([
      ['email.payment_received', 'done'],
      ['invoice.paid', 'done'],
      ['payment.received', 'done'],
      ['payment.reconcile', 'done'],
      ['webhook.deliver', 'done'],
    ]);
  });

  it('generates one invoice per parent and period when the recurring job runs twice', async () => {
    const parent = await invoice({
      isRecurring: true,
      recurringInterval: 'monthly',
      nextRecurringDate: new Date('2026-10-01T00:00:00Z'),
    });
    const generate: Job = { type: 'recurring.generate', payload: {}, jobId: 'recurring:1' };

    await runJob(ctx, generate);
    await dispatcher.drain();
    // A second scheduler tick in the same hour, and a redelivery of the child job.
    await runJob(ctx, { ...generate, jobId: 'recurring:2' });
    await dispatcher.drain();
    await runJob(ctx, {
      type: 'recurring.invoice',
      payload: { parentInvoiceId: parent.id, workspaceId, periodKey: '2026-10' },
      jobId: 'redelivered',
    });

    const children = await base.invoice.findMany({ where: { parentInvoiceId: parent.id } });
    expect(children.map((c) => c.recurringPeriodKey)).toEqual(['2026-10']);
    expect(
      dispatcher.dispatched
        .filter(
          (j) =>
            j.type === 'recurring.invoice' &&
            (j.payload as { parentInvoiceId: string }).parentInvoiceId === parent.id
        )
        .map((j) => j.jobId)
    ).toEqual([`rec:${parent.id}:2026-10`]);
  });

  it('sends a scheduled email once, with a stable idempotency key', async () => {
    await invoice({ dueDate: new Date('2026-10-08T00:00:00Z') });
    await runJob(ctx, { type: 'reminders.scan', payload: {}, jobId: 'scan' });
    const [reminder] = await base.scheduledEmail.findMany({ where: { workspaceId } });
    const send: Job = {
      type: 'email.send',
      payload: { scheduledEmailId: reminder!.id, workspaceId },
      jobId: 'send',
    };

    await runJob(ctx, send);
    await runJob(ctx, send);

    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({
      to: `asha-${run}@example.test`,
      idempotencyKey: `email:${reminder!.id}`,
    });
    const after = await base.scheduledEmail.findUniqueOrThrow({ where: { id: reminder!.id } });
    expect(after).toMatchObject({ status: 'sent', sentAt: NOW });
  });

  it('keeps an email pending with the error when sending fails, and failed when retries run out', async () => {
    await invoice({ dueDate: new Date('2026-10-08T00:00:00Z') });
    await runJob(ctx, { type: 'reminders.scan', payload: {}, jobId: 'scan' });
    const [reminder] = await base.scheduledEmail.findMany({ where: { workspaceId } });
    const send: Job = {
      type: 'email.send',
      payload: { scheduledEmailId: reminder!.id, workspaceId },
      jobId: 'send',
    };
    emailFails = true;

    await expect(runJob(ctx, send)).rejects.toThrow('Resend answered 503');

    const pending = await base.scheduledEmail.findUniqueOrThrow({ where: { id: reminder!.id } });
    expect(pending).toMatchObject({
      status: 'pending',
      retryCount: 1,
      errorMessage: 'Resend answered 503',
    });

    await handleExhaustedJob(ctx, send, new Error('Resend answered 503'));

    const failed = await base.scheduledEmail.findUniqueOrThrow({ where: { id: reminder!.id } });
    expect(failed.status).toBe('failed');
  });

  it("does not send another workspace's email", async () => {
    await invoice({ dueDate: new Date('2026-10-08T00:00:00Z') });
    await runJob(ctx, { type: 'reminders.scan', payload: {}, jobId: 'scan' });
    const [reminder] = await base.scheduledEmail.findMany({ where: { workspaceId } });

    await runJob(ctx, {
      type: 'email.send',
      payload: { scheduledEmailId: reminder!.id, workspaceId: randomUUID() },
      jobId: 'send',
    });

    expect(emails).toHaveLength(0);
  });

  it('renders the public invoice page to a PDF stored under a key derived from the document', async () => {
    const created = await invoice();
    const job: Job = {
      type: 'pdf.render',
      payload: { documentType: 'invoice', documentId: created.id, workspaceId },
      jobId: 'pdf',
    };

    await runJob(ctx, job);
    await runJob(ctx, job);

    const key = pdfKey({
      workspaceId,
      documentType: 'invoice',
      documentId: created.id,
      updatedAt: created.updatedAt,
    });
    expect(rendered).toEqual(Array(2).fill(`https://app.example.test/i/${created.accessToken}`));
    expect(stored).toEqual(Array(2).fill({ key, bytes: 4, contentType: 'application/pdf' }));
    const after = await base.invoice.findUniqueOrThrow({ where: { id: created.id } });
    expect(after.pdfUrl).toBe(key);
  });

  it('marks overdue invoices through its job', async () => {
    const late = await invoice({ dueDate: new Date('2026-09-15T00:00:00Z') });

    await runJob(ctx, { type: 'invoices.mark_overdue', payload: {}, jobId: 'overdue' });

    expect((await base.invoice.findUniqueOrThrow({ where: { id: late.id } })).status).toBe(
      'overdue'
    );
  });

  it('refuses a job whose payload does not fit its type', async () => {
    await expect(
      runJob(ctx, { type: 'webhooks.deliver', payload: { deliveryId: '' } as never, jobId: 'bad' })
    ).rejects.toBeInstanceOf(InvalidJobError);
    await expect(
      runJob(ctx, { type: 'rm -rf' as never, payload: {} as never, jobId: 'bad' })
    ).rejects.toBeInstanceOf(InvalidJobError);
  });

  it('records an exhausted job on its outbox event and leaves an unhandled event pending', async () => {
    const created = await invoice();
    const orphan = await base.outboxEvent.create({
      data: {
        workspaceId,
        type: 'nonsense.happened',
        aggregateType: 'invoice',
        aggregateId: created.id,
      },
    });
    const owed = await base.outboxEvent.create({
      data: {
        workspaceId,
        type: 'email.send',
        aggregateType: 'scheduled_email',
        aggregateId: created.id,
        payload: { scheduledEmailId: randomUUID() },
        status: 'enqueued',
      },
    });

    const result = await relayOutboxToJobs(db, dispatcher, { types: ['nonsense.happened'] });
    await handleExhaustedJob(
      ctx,
      {
        type: 'email.send',
        payload: { scheduledEmailId: 'x', workspaceId },
        jobId: 'j',
        outboxEventId: owed.id,
      },
      new Error('gave up')
    );

    expect(result).toEqual({ enqueued: 0, failed: 1 });
    const rows = new Map(
      (await base.outboxEvent.findMany({ where: { id: { in: [orphan.id, owed.id] } } })).map(
        (r) => [r.id, r]
      )
    );
    expect(rows.get(orphan.id)).toMatchObject({ status: 'pending', attempts: 1 });
    expect(rows.get(orphan.id)!.lastError).toContain('nonsense.happened');
    expect(rows.get(owed.id)).toMatchObject({ status: 'failed', lastError: 'gave up' });
  });

  it('starts runs for overdue invoices when scanning for triggers', async () => {
    const overdue = await invoice({ status: 'overdue' });
    const automation = await base.automation.create({
      data: {
        workspaceId,
        name: 'Overdue nudge',
        trigger: 'invoice.overdue',
        steps: [{ type: 'wait', days: 3 }],
      },
    });

    await runJob(ctx, { type: 'automations.tick', payload: {}, jobId: `scan:${run}` });

    const runs = await base.automationRun.findMany({
      where: { workspaceId, automationId: automation.id },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ subjectId: overdue.id, status: 'running' });
  });

  it('pauses an automation run at approval and resumes on approve', async () => {
    const pipeline = await base.pipeline.create({
      data: { workspace: { connect: { id: workspaceId } }, name: 'Sales' },
    });
    const stage = await base.stage.create({
      data: {
        workspace: { connect: { id: workspaceId } },
        pipeline: { connect: { id: pipeline.id } },
        name: 'New',
        position: 0,
      },
    });
    const nextStage = await base.stage.create({
      data: {
        workspace: { connect: { id: workspaceId } },
        pipeline: { connect: { id: pipeline.id } },
        name: 'Qualified',
        position: 1,
      },
    });
    const deal = await base.deal.create({
      data: {
        workspace: { connect: { id: workspaceId } },
        pipeline: { connect: { id: pipeline.id } },
        stage: { connect: { id: stage.id } },
        title: 'Stalled deal',
        value: 1000,
      },
    });
    const automation = await base.automation.create({
      data: {
        workspaceId,
        name: 'Stalled deal follow-up',
        trigger: 'deal.stalled',
        steps: [
          { type: 'approval', role: 'owner' },
          { type: 'move_deal', stageId: nextStage.id },
        ],
      },
    });
    const run = await base.automationRun.create({
      data: {
        workspaceId,
        automationId: automation.id,
        subjectId: deal.id,
        status: 'running',
        currentStep: 0,
      },
    });

    await runJob(ctx, {
      type: 'automations.tick',
      payload: { runId: run.id },
      jobId: `tick:${run.id}`,
    });

    const paused = await base.automationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(paused.status).toBe('waiting_approval');
    expect(paused.currentStep).toBe(0);

    await approveRun({ db, workspaceId }, run.id, true);

    await runJob(ctx, {
      type: 'automations.tick',
      payload: { runId: run.id },
      jobId: `tick:${run.id}:resume`,
    });

    const done = await base.automationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(done.status).toBe('done');
    expect(done.currentStep).toBe(2);
    const moved = await base.deal.findUniqueOrThrow({ where: { id: deal.id } });
    expect(moved.stageId).toBe(nextStage.id);
  });
});
