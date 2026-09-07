import type { AutomationStep, AutomationTrigger } from '@wolff/contracts';
import { Prisma } from '@wolff/database';
import type { CoreContext, Db, DbTx } from '../context';
import { moveDealInTx } from '../crm/deals';
import { CoreError } from '../errors';
import { writeOutboxEvent } from '../outbox';
import { afterCursor, toCursorPage, type CursorPosition } from '../pagination';

export interface CreateAutomationInput {
  name: string;
  trigger: AutomationTrigger;
  steps: AutomationStep[];
  isActive?: boolean;
}

export interface UpdateAutomationInput {
  name?: string;
  trigger?: AutomationTrigger;
  steps?: AutomationStep[];
  isActive?: boolean;
}

export interface AutomationFilters {
  trigger?: AutomationTrigger;
  isActive?: boolean;
}

export interface ListAutomationsQuery {
  limit: number;
  cursor?: string;
  filters?: AutomationFilters;
}

export interface AutomationRunFilters {
  status?: 'running' | 'waiting_approval' | 'done' | 'cancelled';
  automationId?: string;
}

export interface ListAutomationRunsQuery {
  limit: number;
  cursor?: string;
  filters?: AutomationRunFilters;
}

const subjectTypeOf: Record<AutomationTrigger, string> = {
  'invoice.overdue': 'invoice',
  'quote.sent_no_response': 'quote',
  'deal.stalled': 'deal',
};

function toDbSteps(steps: AutomationStep[]): Prisma.InputJsonValue {
  return steps as unknown as Prisma.InputJsonValue;
}

/**
 * Steps name a stage or an email template by id. Both must belong to the
 * caller's workspace; the ids come from the request body.
 */
async function assertStepReferences(ctx: CoreContext, steps: AutomationStep[]): Promise<void> {
  const stageIds = steps.flatMap((s) => (s.type === 'move_deal' ? [s.stageId] : []));
  const templateIds = steps.flatMap((s) => (s.type === 'send_email' ? [s.templateId] : []));
  const [stages, templates] = await Promise.all([
    stageIds.length
      ? ctx.db.stage.count({ where: { workspaceId: ctx.workspaceId, id: { in: stageIds } } })
      : 0,
    templateIds.length
      ? ctx.db.emailTemplate.count({
          where: { workspaceId: ctx.workspaceId, id: { in: templateIds } },
        })
      : 0,
  ]);
  const details: Record<string, string[]> = {};
  if (stages !== new Set(stageIds).size)
    details.steps = ['A move_deal step names an unknown stage'];
  if (templates !== new Set(templateIds).size) {
    details.steps = [...(details.steps ?? []), 'A send_email step names an unknown template'];
  }
  if (Object.keys(details).length > 0) {
    throw new CoreError('validation_error', 'The automation refers to unknown records', details);
  }
}

export async function createAutomation(ctx: CoreContext, input: CreateAutomationInput) {
  await assertStepReferences(ctx, input.steps);
  return ctx.db.automation.create({
    data: {
      workspaceId: ctx.workspaceId,
      name: input.name,
      trigger: input.trigger,
      steps: toDbSteps(input.steps),
      isActive: input.isActive ?? true,
    },
  });
}

export async function updateAutomation(ctx: CoreContext, id: string, input: UpdateAutomationInput) {
  const existing = await ctx.db.automation.findFirst({
    where: { id, workspaceId: ctx.workspaceId },
  });
  if (!existing) return null;
  if (input.steps) await assertStepReferences(ctx, input.steps);
  return ctx.db.automation.update({
    where: { id, workspaceId: ctx.workspaceId },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.trigger !== undefined && { trigger: input.trigger }),
      ...(input.steps !== undefined && { steps: toDbSteps(input.steps) }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
    },
  });
}

export async function deleteAutomation(ctx: CoreContext, id: string) {
  const existing = await ctx.db.automation.findFirst({
    where: { id, workspaceId: ctx.workspaceId },
  });
  if (!existing) return null;
  await ctx.db.automation.delete({ where: { id, workspaceId: ctx.workspaceId } });
  return existing;
}

export async function getAutomation(ctx: CoreContext, id: string) {
  return ctx.db.automation.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
}

export async function listAutomations(ctx: CoreContext, query: ListAutomationsQuery) {
  const { limit, cursor, filters } = query;
  const where: Prisma.AutomationWhereInput = {
    workspaceId: ctx.workspaceId,
    ...afterCursor(cursor),
    ...(filters?.trigger && { trigger: filters.trigger }),
    ...(filters?.isActive !== undefined && { isActive: filters.isActive }),
  };
  const [items, total] = await Promise.all([
    ctx.db.automation.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    }),
    ctx.db.automation.count({ where: { workspaceId: ctx.workspaceId } }),
  ]);
  const page = toCursorPage(items, limit);
  return { ...page, meta: { ...page.meta, total } };
}

export async function listAutomationRuns(ctx: CoreContext, query: ListAutomationRunsQuery) {
  const { limit, cursor, filters } = query;
  const where: Prisma.AutomationRunWhereInput = {
    workspaceId: ctx.workspaceId,
    ...afterCursor(cursor),
    ...(filters?.status && { status: filters.status }),
    ...(filters?.automationId && { automationId: filters.automationId }),
  };
  const countWhere: Prisma.AutomationRunWhereInput = {
    workspaceId: ctx.workspaceId,
    ...(filters?.status && { status: filters.status }),
    ...(filters?.automationId && { automationId: filters.automationId }),
  };
  const [items, total] = await Promise.all([
    ctx.db.automationRun.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: { automation: { select: { name: true, trigger: true } } },
    }),
    ctx.db.automationRun.count({ where: countWhere }),
  ]);
  const page = toCursorPage(items, limit);
  return { ...page, meta: { ...page.meta, total } };
}

export async function getAutomationRun(ctx: CoreContext, id: string) {
  return ctx.db.automationRun.findFirst({
    where: { id, workspaceId: ctx.workspaceId },
    include: { automation: { select: { name: true, trigger: true, steps: true } } },
  });
}

export interface TickDispatch {
  (runId: string, stepIndex: number, delayMs: number): Promise<void>;
}

interface LogEntry {
  at: string;
  stepIndex: number;
  action: string;
  message: string;
  actorId?: string;
}

function pushLog(run: { log: Prisma.JsonValue }, entry: LogEntry): Prisma.InputJsonValue {
  const existing = Array.isArray(run.log) ? (run.log as unknown as LogEntry[]) : [];
  return [...existing, entry] as unknown as Prisma.InputJsonValue;
}

const ROLE_RANK: Record<string, number> = { viewer: 0, member: 1, editor: 1, admin: 2, owner: 3 };

/**
 * Decides a run that is waiting at an approval step. The decision belongs to
 * a person ("approve or reject in the app") whose workspace role
 * is at least the role the step names; an API key has no person behind it
 * and is refused.
 *
 * The status check and the change are one conditional update, so of two
 * concurrent decisions exactly one applies. An approval also queues the
 * run's next tick through the outbox, in the same transaction.
 */
export async function approveRun(ctx: CoreContext, id: string, approved: boolean) {
  const run = await ctx.db.automationRun.findFirst({
    where: { id, workspaceId: ctx.workspaceId, status: 'waiting_approval' },
    include: { automation: { select: { steps: true } } },
  });
  if (!run) return null;

  const steps = Array.isArray(run.automation.steps)
    ? (run.automation.steps as unknown as AutomationStep[])
    : [];
  const step = steps[run.currentStep];
  const required = step?.type === 'approval' ? step.role : 'owner';
  await assertMayDecide(ctx, required);

  const entry: LogEntry = approved
    ? {
        at: new Date().toISOString(),
        stepIndex: run.currentStep,
        action: 'approval_approved',
        message: 'Approved; continuing.',
      }
    : {
        at: new Date().toISOString(),
        stepIndex: run.currentStep,
        action: 'approval_rejected',
        message: 'Run rejected by user.',
      };
  if (ctx.actorId) entry.actorId = ctx.actorId;

  return ctx.db.$transaction(async (tx) => {
    const changed = await tx.automationRun.updateMany({
      where: {
        id,
        workspaceId: ctx.workspaceId,
        status: 'waiting_approval',
        currentStep: run.currentStep,
      },
      data: approved
        ? {
            status: 'running',
            waitingSince: null,
            currentStep: run.currentStep + 1,
            log: pushLog(run, entry),
          }
        : { status: 'cancelled', log: pushLog(run, entry) },
    });
    if (changed.count === 0) return null;

    if (approved) {
      await writeOutboxEvent(tx, {
        workspaceId: ctx.workspaceId,
        type: 'automation.tick',
        aggregateType: 'automation_run',
        aggregateId: id,
        payload: { runId: id },
      });
    }
    return tx.automationRun.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
  });
}

async function assertMayDecide(ctx: CoreContext, required: string): Promise<void> {
  if (!ctx.actorId) {
    throw new CoreError(
      'insufficient_scope',
      'Approvals are decided by a workspace member in the app, not with an API key'
    );
  }
  const membership = await ctx.db.workspaceMember.findFirst({
    where: { workspaceId: ctx.workspaceId, userId: ctx.actorId },
    select: { role: true },
  });
  const rank = membership ? (ROLE_RANK[membership.role] ?? 0) : -1;
  if (rank < (ROLE_RANK[required] ?? ROLE_RANK.owner!)) {
    throw new CoreError('insufficient_scope', `This approval needs the ${required} role`);
  }
}

export async function tickAutomationRun(
  ctx: CoreContext,
  runId: string,
  options: { dispatch: TickDispatch; now: Date }
) {
  const run = await ctx.db.automationRun.findFirst({
    where: { id: runId, workspaceId: ctx.workspaceId },
    include: { automation: true },
  });
  if (!run) return null;
  if (run.status !== 'running') return run;

  const steps = Array.isArray(run.automation.steps)
    ? (run.automation.steps as unknown as AutomationStep[])
    : [];
  if (run.currentStep >= steps.length) {
    return transition(ctx.db, ctx, run, { status: 'done' });
  }

  const step = steps[run.currentStep];
  if (!step) return run;

  if (step.type === 'wait') {
    if (!run.waitingSince) {
      // Starting a wait does not change the step, so the status/step
      // condition alone lets two ticks both start it; only one finds
      // waitingSince still empty.
      const started = await transition(
        ctx.db,
        ctx,
        run,
        {
          waitingSince: options.now,
          log: pushLog(run, {
            at: options.now.toISOString(),
            stepIndex: run.currentStep,
            action: 'wait_started',
            message: `Waiting ${step.days} day(s).`,
          }),
        },
        { waitingSince: null }
      );
      // Only the tick that started the wait schedules its end.
      if (started) await options.dispatch(run.id, run.currentStep, step.days * 86_400_000);
      return started ?? run;
    }
    const elapsed = options.now.getTime() - run.waitingSince.getTime();
    if (elapsed < step.days * 86_400_000) return run;
    return advanceRun(ctx, run, `Waited ${step.days} day(s).`);
  }

  if (step.type === 'approval') {
    // The step "pauses the run and notifies". The pause and the
    // in-app notifications commit together, for the tick that paused it.
    return ctx.db.$transaction(async (tx) => {
      const paused = await transition(tx, ctx, run, {
        status: 'waiting_approval',
        waitingSince: options.now,
        log: pushLog(run, {
          at: options.now.toISOString(),
          stepIndex: run.currentStep,
          action: 'approval_requested',
          message: `Waiting for ${step.role} approval.`,
        }),
      });
      if (!paused) return run;
      await notifyApprovers(tx, ctx.workspaceId, run, step.role);
      return paused;
    });
  }

  if (step.type === 'send_email') {
    const template = await ctx.db.emailTemplate.findFirst({
      where: { id: step.templateId, workspaceId: ctx.workspaceId },
    });
    const subject = template ? await resolveSubject(ctx, run) : null;
    if (!template || !subject?.email) {
      return advanceRun(
        ctx,
        run,
        template ? 'No recipient email; skipped.' : 'Email template not found; skipped.'
      );
    }
    // The email, its send job and the step advance commit together, and only
    // if the run is still on this step: a repeated tick sends nothing twice.
    return ctx.db.$transaction(async (tx) => {
      const moved = await transition(
        tx,
        ctx,
        run,
        completedStep(run, 'Email queued.', options.now)
      );
      if (moved) {
        const email = await tx.scheduledEmail.create({
          data: {
            workspaceId: ctx.workspaceId,
            templateId: template.id,
            type: 'automation',
            entityType:
              subjectTypeOf[run.automation.trigger as AutomationTrigger] ?? 'automation_run',
            entityId: run.subjectId,
            recipientEmail: subject.email!,
            recipientName: subject.name ?? '',
            subject: template.subject,
            body: template.body,
            scheduledFor: options.now,
          },
        });
        await writeOutboxEvent(tx, {
          workspaceId: ctx.workspaceId,
          type: 'email.send',
          aggregateType: 'scheduled_email',
          aggregateId: email.id,
          payload: { scheduledEmailId: email.id, workspaceId: ctx.workspaceId },
        });
      }
      return tx.automationRun.findFirst({ where: { id: run.id, workspaceId: ctx.workspaceId } });
    });
  }

  if (step.type === 'ai_draft_email') {
    return advanceRun(ctx, run, 'AI draft step skipped (no AI provider configured).');
  }

  if (step.type === 'move_deal') {
    const deal = await ctx.db.deal.findFirst({
      where: { id: run.subjectId, workspaceId: ctx.workspaceId, deletedAt: null },
    });
    // The stage must be in this workspace and on the deal's own pipeline;
    // the id was checked when the automation was saved, but the stage may
    // have been deleted or the deal moved to another pipeline since.
    const stage = deal
      ? await ctx.db.stage.findFirst({
          where: { id: step.stageId, workspaceId: ctx.workspaceId, pipelineId: deal.pipelineId },
        })
      : null;
    const message = !deal
      ? 'Deal not found; skipped.'
      : stage
        ? 'Deal moved.'
        : 'Stage not found; skipped.';
    // The move and the step advance commit together, and only for the tick
    // that still finds the run on this step. The move goes through the same
    // code as a manual one: won/lost dates and a stage_changed activity.
    return ctx.db.$transaction(async (tx) => {
      const moved = await transition(tx, ctx, run, completedStep(run, message, options.now));
      if (moved && deal && stage) {
        await moveDealInTx(
          tx,
          { workspaceId: ctx.workspaceId },
          { dealId: deal.id, stageId: stage.id },
          { source: 'automation', automationRunId: run.id }
        );
      }
      return moved ?? run;
    });
  }

  return run;
}

/**
 * An in-app notification for each member whose role may decide the
 * approval (the same ranking approveRun checks).
 */
async function notifyApprovers(
  tx: DbTx,
  workspaceId: string,
  run: { id: string; automation: { name: string } },
  role: string
): Promise<void> {
  const needed = ROLE_RANK[role] ?? ROLE_RANK.owner!;
  const members = await tx.workspaceMember.findMany({
    where: { workspaceId },
    select: { userId: true, role: true },
  });
  const approvers = members.filter((m) => (ROLE_RANK[m.role] ?? -1) >= needed);
  if (approvers.length === 0) return;
  await tx.notification.createMany({
    data: approvers.map((m) => ({
      userId: m.userId,
      workspaceId,
      type: 'automation_approval',
      title: `Approval needed: ${run.automation.name}`,
      message: `An automation run is waiting for ${role} approval.`,
      entityType: 'automation_run',
      entityId: run.id,
      link: '/automations',
    })),
  });
}

type RunState = { id: string; currentStep: number; log: Prisma.JsonValue };
type RunClient = Pick<Db, 'automationRun'>;

/**
 * Applies a change to a run only if it is still running at the step this
 * tick read. Two ticks for the same (run, step) can both read the run; this
 * makes exactly one of them move it, so each step runs once. Returns the
 * updated run, or null when another tick got there first.
 */
async function transition(
  db: RunClient,
  ctx: CoreContext,
  run: RunState,
  data: Prisma.AutomationRunUpdateManyMutationInput,
  also: Prisma.AutomationRunWhereInput = {}
) {
  const changed = await db.automationRun.updateMany({
    where: {
      ...also,
      id: run.id,
      workspaceId: ctx.workspaceId,
      status: 'running',
      currentStep: run.currentStep,
    },
    data,
  });
  if (changed.count !== 1) return null;
  return db.automationRun.findFirst({ where: { id: run.id, workspaceId: ctx.workspaceId } });
}

function completedStep(
  run: RunState,
  message: string,
  at = new Date()
): Prisma.AutomationRunUpdateManyMutationInput {
  return {
    currentStep: run.currentStep + 1,
    waitingSince: null,
    log: pushLog(run, {
      at: at.toISOString(),
      stepIndex: run.currentStep,
      action: 'step_completed',
      message,
    }),
  };
}

async function advanceRun<R extends RunState>(ctx: CoreContext, run: R, message: string) {
  return (await transition(ctx.db, ctx, run, completedStep(run, message))) ?? run;
}

async function resolveSubject(
  { db, workspaceId }: CoreContext,
  run: { subjectId: string; automation: { trigger: string } }
): Promise<{ name: string | null; email: string | null } | null> {
  const trigger = run.automation.trigger as AutomationTrigger;
  if (trigger === 'invoice.overdue') {
    const invoice = await db.invoice.findFirst({
      where: { id: run.subjectId, workspaceId },
      include: { client: { select: { name: true, email: true } } },
    });
    return invoice?.client ?? null;
  }
  if (trigger === 'quote.sent_no_response') {
    const quote = await db.quote.findFirst({
      where: { id: run.subjectId, workspaceId },
      include: { client: { select: { name: true, email: true } } },
    });
    return quote?.client ?? null;
  }
  if (trigger === 'deal.stalled') {
    const deal = await db.deal.findFirst({
      where: { id: run.subjectId, workspaceId },
      include: {
        lead: { select: { name: true, email: true } },
        client: { select: { name: true, email: true } },
      },
    });
    return deal?.client ?? deal?.lead ?? null;
  }
  return null;
}

/** A run that has not moved for this long, on a step that is not a wait, is stuck. */
const STUCK_AFTER_MS = 15 * 60_000;

/**
 * Ids of running runs that have work to do now, for the periodic tick: a
 * wait whose days are over (its wake-up job was lost or late), or a run
 * that has not moved for 15 minutes on any other step (its tick failed). A
 * run still inside a wait is left alone, so the tick costs nothing for it.
 */
export async function listDueAutomationRuns(
  db: Db,
  options: { now: Date; limit?: number }
): Promise<string[]> {
  const now = options.now.getTime();
  const runs = await db.$unscoped.automationRun.findMany({
    where: { status: 'running' },
    select: {
      id: true,
      currentStep: true,
      waitingSince: true,
      updatedAt: true,
      automation: { select: { steps: true } },
    },
    orderBy: { updatedAt: 'asc' },
    take: 1000,
  });
  const due: string[] = [];
  for (const run of runs) {
    const steps = Array.isArray(run.automation.steps)
      ? (run.automation.steps as unknown as AutomationStep[])
      : [];
    const step = steps[run.currentStep];
    const waitEnds =
      step?.type === 'wait' && run.waitingSince
        ? run.waitingSince.getTime() + step.days * 86_400_000
        : null;
    const isDue =
      waitEnds !== null ? waitEnds <= now : now - run.updatedAt.getTime() >= STUCK_AFTER_MS;
    if (isDue) due.push(run.id);
    if (due.length >= (options.limit ?? 100)) break;
  }
  return due;
}

const STALL_DAYS = 7;

/**
 * Up to `take` subjects the automation's trigger matches that have no run of
 * this automation yet. The "no run yet" check is a NOT EXISTS in the query,
 * so its cost does not grow with the number of runs the automation has had.
 * Pinned to the automation's own workspace.
 */
async function newTriggerSubjects(
  db: Db,
  automation: { id: string; workspaceId: string; trigger: string },
  options: { now: Date; take: number }
): Promise<string[]> {
  const stallCutoff = new Date(options.now.getTime() - STALL_DAYS * 86_400_000);
  const ws = automation.workspaceId;
  const noRun = Prisma.sql`NOT EXISTS (SELECT 1 FROM automation_runs r
    WHERE r.automation_id = ${automation.id} AND r.subject_id = s.id)`;
  let rows: { id: string }[];
  switch (automation.trigger) {
    case 'invoice.overdue':
      rows = await db.$unscoped.$queryRaw<{ id: string }[]>`
        SELECT s.id FROM invoices s
        WHERE s.workspace_id = ${ws} AND s.status = 'overdue' AND ${noRun}
        ORDER BY s.id LIMIT ${options.take}`;
      break;
    case 'quote.sent_no_response':
      rows = await db.$unscoped.$queryRaw<{ id: string }[]>`
        SELECT s.id FROM quotes s
        WHERE s.workspace_id = ${ws} AND s.status = 'sent' AND s.updated_at < ${stallCutoff}
          AND ${noRun}
        ORDER BY s.id LIMIT ${options.take}`;
      break;
    case 'deal.stalled':
      rows = await db.$unscoped.$queryRaw<{ id: string }[]>`
        SELECT s.id FROM deals s
        WHERE s.workspace_id = ${ws} AND s.updated_at < ${stallCutoff} AND ${noRun}
        ORDER BY s.id LIMIT ${options.take}`;
      break;
    default:
      return [];
  }
  return rows.map((row) => row.id);
}

/**
 * Starts a run for each subject an active automation's trigger matches and
 * that has no run of that automation yet: per automation one query and one
 * insert. At most `limit` runs per scan and `perAutomation` per automation,
 * so one busy automation cannot take a whole scan from the others; the next
 * scan starts the rest. One automation failing does not stop the scan. The
 * unique (automation, subject) index makes overlapping scans safe: the
 * second insert of a pair is skipped.
 */
export async function scanAutomationTriggers(
  db: Db,
  options: {
    now: Date;
    limit?: number;
    perAutomation?: number;
    onError?: (error: unknown, automationId: string) => void;
  }
): Promise<string[]> {
  let remaining = options.limit ?? 200;
  const perAutomation = options.perAutomation ?? 50;
  // The scheduler runs for every workspace, so this one list is unscoped;
  // everything after it is pinned to the automation's own workspace.
  const automations = await db.$unscoped.automation.findMany({
    where: { isActive: true },
    orderBy: { id: 'asc' },
  });
  const created: string[] = [];

  for (const automation of automations) {
    if (remaining <= 0) break;
    if (!subjectTypeOf[automation.trigger as AutomationTrigger]) continue;
    try {
      const subjects = await newTriggerSubjects(db, automation, {
        now: options.now,
        take: Math.min(remaining, perAutomation),
      });
      if (subjects.length === 0) continue;
      const runs = await db.automationRun.createManyAndReturn({
        data: subjects.map((subjectId) => ({
          workspaceId: automation.workspaceId,
          automationId: automation.id,
          subjectId,
          status: 'running',
        })),
        select: { id: true },
        skipDuplicates: true,
      });
      for (const run of runs) created.push(run.id);
      remaining -= runs.length;
    } catch (error) {
      options.onError?.(error, automation.id);
    }
  }

  return created;
}
