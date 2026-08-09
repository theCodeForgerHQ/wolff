import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrisma, withTenantGuard } from '@wolff/database';
import { CoreError } from '../errors';
import { approveRun } from '.';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('automation approvals (Postgres)', () => {
  const base = createPrisma(url);
  const db = withTenantGuard(base, { mode: 'throw' });
  const run = randomUUID().replace(/-/g, '');
  let workspaceId = '';
  let ownerId = '';
  let memberId = '';
  let automationId = '';

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
  });

  afterAll(async () => {
    await base.outboxEvent.deleteMany({ where: { workspaceId } });
    await base.automationRun.deleteMany({ where: { workspaceId } });
    await base.automation.deleteMany({ where: { workspaceId } });
    await base.workspaceMember.deleteMany({ where: { workspaceId } });
    await base.workspace.deleteMany({ where: { id: workspaceId } });
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

  it('applies one of two concurrent decisions', async () => {
    const waiting = await waitingRun();
    // Hold every read of the run until both decisions have read it, so both
    // see it waiting: the case a read-then-update gets wrong.
    let reads = 0;
    let release: () => void = () => {};
    const bothRead = new Promise<void>((resolve) => (release = resolve));
    const racy = db.$extends({
      query: {
        automationRun: {
          async findFirst({ args, query }) {
            const result = await query(args);
            if (++reads === 2) release();
            await bothRead;
            return result;
          },
        },
      },
    }) as unknown as typeof db;
    const ctx = { db: racy, workspaceId, actorId: ownerId };

    const results = await Promise.all([
      approveRun(ctx, waiting.id, true),
      approveRun(ctx, waiting.id, false),
    ]);

    expect(results.filter((r) => r !== null)).toHaveLength(1);
    const after = await base.automationRun.findUniqueOrThrow({ where: { id: waiting.id } });
    expect((after.log as unknown[]).length).toBe(1);
  });
});
