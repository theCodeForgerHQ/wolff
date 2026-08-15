import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrisma, withTenantGuard } from '@wolff/database';
import { CoreError } from '../errors';
import { approveRun, createAutomation, tickAutomationRun } from '.';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('automation approvals (Postgres)', () => {
  const base = createPrisma(url);
  const db = withTenantGuard(base, { mode: 'throw' });
  const run = randomUUID().replace(/-/g, '');
  let workspaceId = '';
  let ownerId = '';
  let memberId = '';
  let automationId = '';
  let otherWorkspaceId = '';

  beforeAll(async () => {
    const owner = await base.user.create({
      data: { email: `owner-${run}@example.test`, name: 'Owner' },
    });
    const member = await base.user.create({
      data: { email: `member-${run}@example.test`, name: 'Member' },
    });
    ownerId = owner.id;
    memberId = member.id;
    const workspace = await base.workspace.create({
      data: {
        name: 'Approvals',
        slug: `approvals-${run}`,
        ownerId,
        members: {
          create: [
            { userId: ownerId, role: 'owner' },
            { userId: memberId, role: 'member' },
          ],
        },
      },
    });
    workspaceId = workspace.id;
    const automation = await base.automation.create({
      data: {
        workspaceId,
        name: 'Firm notice',
        trigger: 'invoice.overdue',
        steps: [
          { type: 'approval', role: 'admin' },
          { type: 'wait', days: 1 },
        ],
        isActive: false,
      },
    });
    automationId = automation.id;
    const other = await base.workspace.create({
      data: { name: 'Other', slug: `approvals-other-${run}` },
    });
    otherWorkspaceId = other.id;
  });

  afterAll(async () => {
    await base.outboxEvent.deleteMany({ where: { workspaceId } });
    await base.notification.deleteMany({ where: { workspaceId } });
    await base.scheduledEmail.deleteMany({ where: { workspaceId } });
    await base.emailTemplate.deleteMany({ where: { workspaceId } });
    await base.invoice.deleteMany({ where: { workspaceId } });
    await base.client.deleteMany({ where: { workspaceId } });
    for (const ws of [workspaceId, otherWorkspaceId]) {
      await base.deal.deleteMany({ where: { workspaceId: ws } });
      await base.stage.deleteMany({ where: { workspaceId: ws } });
      await base.pipeline.deleteMany({ where: { workspaceId: ws } });
    }
    await base.automationRun.deleteMany({ where: { workspaceId } });
    await base.automation.deleteMany({ where: { workspaceId } });
    await base.workspaceMember.deleteMany({ where: { workspaceId } });
    await base.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
    await base.user.deleteMany({ where: { id: { in: [ownerId, memberId] } } });
    await base.$disconnect();
  });

  const waitingRun = () =>
    base.automationRun.create({
      data: {
        workspaceId,
        automationId,
        subjectId: randomUUID(),
        status: 'waiting_approval',
        currentStep: 0,
      },
    });

  it('lets a member with the step role approve, and queues the run to continue', async () => {
    const waiting = await waitingRun();

    const approved = await approveRun({ db, workspaceId, actorId: ownerId }, waiting.id, true);

    expect(approved).toMatchObject({ status: 'running', currentStep: 1 });
    const queued = await base.outboxEvent.findMany({
      where: { workspaceId, aggregateId: waiting.id },
    });
    expect(queued.map((e) => [e.type, e.payload])).toEqual([
      ['automation.tick', { runId: waiting.id }],
    ]);
  });

  it('refuses a member below the role the step asks for', async () => {
    const waiting = await waitingRun();

    await expect(
      approveRun({ db, workspaceId, actorId: memberId }, waiting.id, true)
    ).rejects.toBeInstanceOf(CoreError);
    await expect(
      approveRun({ db, workspaceId, actorId: memberId }, waiting.id, false)
    ).rejects.toBeInstanceOf(CoreError);

    const unchanged = await base.automationRun.findUniqueOrThrow({ where: { id: waiting.id } });
    expect(unchanged.status).toBe('waiting_approval');
  });

  it('refuses a decision without a person behind it (an API key)', async () => {
    const waiting = await waitingRun();

    await expect(approveRun({ db, workspaceId }, waiting.id, true)).rejects.toBeInstanceOf(
      CoreError
    );
  });

  /**
   * A client whose first two reads of a run wait for each other, so two
   * concurrent callers both see the same state: the case a read-then-update
   * gets wrong. Later reads pass straight through.
   */
  const racyDb = () => {
    let reads = 0;
    let release: () => void = () => {};
    const bothRead = new Promise<void>((resolve) => (release = resolve));
    return db.$extends({
      query: {
        automationRun: {
          async findFirst({ args, query }) {
            const result = await query(args);
            if (++reads > 2) return result;
            if (reads === 2) release();
            await bothRead;
            return result;
          },
        },
      },
    }) as unknown as typeof db;
  };

  it('applies one of two concurrent decisions', async () => {
    const waiting = await waitingRun();
    const ctx = { db: racyDb(), workspaceId, actorId: ownerId };

    const results = await Promise.all([
      approveRun(ctx, waiting.id, true),
      approveRun(ctx, waiting.id, false),
    ]);

    expect(results.filter((r) => r !== null)).toHaveLength(1);
    const after = await base.automationRun.findUniqueOrThrow({ where: { id: waiting.id } });
    expect((after.log as unknown[]).length).toBe(1);
  });
  const pipelineWithStages = async (ws: string) => {
    const pipeline = await base.pipeline.create({ data: { workspaceId: ws, name: 'Sales' } });
    const [first, second] = await Promise.all(
      [0, 1].map((position) =>
        base.stage.create({
          data: { workspaceId: ws, pipelineId: pipeline.id, name: `S${position}`, position },
        })
      )
    );
    return { pipeline, first: first!, second: second! };
  };

  it('does not move a deal to a stage of another workspace', async () => {
    const mine = await pipelineWithStages(workspaceId);
    const theirs = await pipelineWithStages(otherWorkspaceId);
    const deal = await base.deal.create({
      data: {
        workspaceId,
        pipelineId: mine.pipeline.id,
        stageId: mine.first.id,
        title: 'Deal',
        value: 10,
      },
    });
    // Written directly: creating it through core is refused (next test).
    const automation = await base.automation.create({
      data: {
        workspaceId,
        name: 'Move',
        trigger: 'deal.stalled',
        steps: [{ type: 'move_deal', stageId: theirs.second.id }],
        isActive: false,
      },
    });
    const moving = await base.automationRun.create({
      data: { workspaceId, automationId: automation.id, subjectId: deal.id, status: 'running' },
    });

    await tickAutomationRun({ db, workspaceId }, moving.id, {
      dispatch: async () => {},
      now: new Date(),
    });

    expect((await base.deal.findUniqueOrThrow({ where: { id: deal.id } })).stageId).toBe(
      mine.first.id
    );
  });

  it('refuses to save a step that names a stage or template outside the workspace', async () => {
    const theirs = await pipelineWithStages(otherWorkspaceId);

    await expect(
      createAutomation(
        { db, workspaceId },
        {
          name: 'Bad',
          trigger: 'deal.stalled',
          steps: [{ type: 'move_deal', stageId: theirs.first.id }],
        }
      )
    ).rejects.toBeInstanceOf(CoreError);
    await expect(
      createAutomation(
        { db, workspaceId },
        {
          name: 'Bad',
          trigger: 'invoice.overdue',
          steps: [{ type: 'send_email', templateId: randomUUID() }],
        }
      )
    ).rejects.toBeInstanceOf(CoreError);
  });
  it('queues the email of a send_email step for sending, once', async () => {
    const client = await base.client.create({
      data: { workspaceId, name: 'Asha', email: `asha-${run}@example.test` },
    });
    const invoice = await base.invoice.create({
      data: {
        workspaceId,
        clientId: client.id,
        invoiceNumber: `AUTO-${run.slice(0, 8)}`,
        status: 'overdue',
        dueDate: new Date('2026-09-01'),
        total: 100,
        amountDue: 100,
      },
    });
    const template = await base.emailTemplate.create({
      data: {
        workspaceId,
        type: 'reminder',
        name: 'Nudge',
        subject: 'Reminder',
        body: '<p>Hi</p>',
      },
    });
    const automation = await base.automation.create({
      data: {
        workspaceId,
        name: 'Email',
        trigger: 'invoice.overdue',
        steps: [{ type: 'send_email', templateId: template.id }],
        isActive: false,
      },
    });
    const emailing = await base.automationRun.create({
      data: { workspaceId, automationId: automation.id, subjectId: invoice.id, status: 'running' },
    });
    const tick = () =>
      tickAutomationRun({ db, workspaceId }, emailing.id, {
        dispatch: async () => {},
        now: new Date(),
      });

    await tick();
    await tick();

    const emails = await base.scheduledEmail.findMany({
      where: { workspaceId, entityId: invoice.id },
    });
    expect(emails.map((e) => e.recipientEmail)).toEqual([client.email]);
    const queued = await base.outboxEvent.findMany({
      where: { workspaceId, type: 'email.send', aggregateId: emails[0]!.id },
    });
    expect(queued).toHaveLength(1);
  });

  it('advances one step for two concurrent ticks, and stops at the approval', async () => {
    const { pipeline, first, second } = await pipelineWithStages(workspaceId);
    const deal = await base.deal.create({
      data: { workspaceId, pipelineId: pipeline.id, stageId: first.id, title: 'Race', value: 1 },
    });
    const automation = await base.automation.create({
      data: {
        workspaceId,
        name: 'Move then ask',
        trigger: 'deal.stalled',
        steps: [
          { type: 'move_deal', stageId: second.id },
          { type: 'approval', role: 'admin' },
          { type: 'wait', days: 1 },
        ],
        isActive: false,
      },
    });
    const racing = await base.automationRun.create({
      data: { workspaceId, automationId: automation.id, subjectId: deal.id, status: 'running' },
    });
    const ctx = { db: racyDb(), workspaceId };
    const tick = () =>
      tickAutomationRun(ctx, racing.id, { dispatch: async () => {}, now: new Date() });

    await Promise.all([tick(), tick()]);

    const after = await base.automationRun.findUniqueOrThrow({ where: { id: racing.id } });
    expect(after.currentStep).toBe(1);
    expect((after.log as { action: string }[]).map((e) => e.action)).toEqual(['step_completed']);

    // The next tick reaches the approval and pauses there.
    await tick();
    const paused = await base.automationRun.findUniqueOrThrow({ where: { id: racing.id } });
    expect(paused).toMatchObject({ status: 'waiting_approval', currentStep: 1 });
  });

  it('does not move a deal to a stage of another pipeline in the same workspace', async () => {
    const mine = await pipelineWithStages(workspaceId);
    const otherPipeline = await pipelineWithStages(workspaceId);
    const deal = await base.deal.create({
      data: {
        workspaceId,
        pipelineId: mine.pipeline.id,
        stageId: mine.first.id,
        title: 'Pipeline',
        value: 10,
      },
    });
    const automation = await base.automation.create({
      data: {
        workspaceId,
        name: 'Move across',
        trigger: 'deal.stalled',
        steps: [{ type: 'move_deal', stageId: otherPipeline.second.id }],
        isActive: false,
      },
    });
    const moving = await base.automationRun.create({
      data: { workspaceId, automationId: automation.id, subjectId: deal.id, status: 'running' },
    });

    await tickAutomationRun({ db, workspaceId }, moving.id, {
      dispatch: async () => {},
      now: new Date(),
    });

    expect((await base.deal.findUniqueOrThrow({ where: { id: deal.id } })).stageId).toBe(
      mine.first.id
    );
    const after = await base.automationRun.findUniqueOrThrow({ where: { id: moving.id } });
    expect((after.log as { message: string }[]).map((e) => e.message)).toEqual([
      'Stage not found; skipped.',
    ]);
  });

  it('queues one email for two concurrent ticks of a send_email step', async () => {
    const client = await base.client.create({
      data: { workspaceId, name: 'Ravi', email: `ravi-${run}@example.test` },
    });
    const invoice = await base.invoice.create({
      data: {
        workspaceId,
        clientId: client.id,
        invoiceNumber: `RACE-${run.slice(0, 8)}`,
        status: 'overdue',
        dueDate: new Date('2026-09-01'),
        total: 100,
        amountDue: 100,
      },
    });
    const template = await base.emailTemplate.create({
      data: { workspaceId, type: 'reminder', name: 'Race', subject: 'Reminder', body: '<p>Hi</p>' },
    });
    const automation = await base.automation.create({
      data: {
        workspaceId,
        name: 'Email race',
        trigger: 'invoice.overdue',
        steps: [{ type: 'send_email', templateId: template.id }],
        isActive: false,
      },
    });
    const emailing = await base.automationRun.create({
      data: { workspaceId, automationId: automation.id, subjectId: invoice.id, status: 'running' },
    });
    const ctx = { db: racyDb(), workspaceId };
    const tick = () =>
      tickAutomationRun(ctx, emailing.id, { dispatch: async () => {}, now: new Date() });

    await Promise.all([tick(), tick()]);

    const emails = await base.scheduledEmail.findMany({
      where: { workspaceId, entityId: invoice.id },
    });
    expect(emails).toHaveLength(1);
  });

  it('notifies the members who may decide when a run reaches an approval step', async () => {
    const asking = await base.automationRun.create({
      data: { workspaceId, automationId, subjectId: randomUUID(), status: 'running' },
    });
    const racy = racyDb();
    const tick = () =>
      tickAutomationRun({ db: racy, workspaceId }, asking.id, {
        dispatch: async () => {},
        now: new Date(),
      });

    // Two concurrent ticks reach the step; one notification per person.
    await Promise.all([tick(), tick()]);

    const notes = await base.notification.findMany({
      where: { workspaceId, entityId: asking.id },
    });
    // The step asks for an admin: the owner may decide, the member may not.
    expect(notes.map((n) => [n.userId, n.type, n.link])).toEqual([
      [ownerId, 'automation_approval', '/automations'],
    ]);
  });
});
