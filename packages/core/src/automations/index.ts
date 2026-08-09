import type { AutomationStep, AutomationTrigger } from '@wolff/contracts';
import type { Prisma } from '@wolff/database';
import type { CoreContext, Db } from '../context';
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
  const page = toCursorPage(items, limit + 1);
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
  const page = toCursorPage(items, limit + 1);
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
    return ctx.db.automationRun.update({
      where: { id: run.id, workspaceId: ctx.workspaceId },
      data: { status: 'done' },
    });
  }

  const step = steps[run.currentStep];
  if (!step) return run;

  if (step.type === 'wait') {
    if (!run.waitingSince) {
      await ctx.db.automationRun.update({
        where: { id: run.id, workspaceId: ctx.workspaceId },
        data: {
          waitingSince: options.now,
          log: pushLog(run, {
            at: options.now.toISOString(),
            stepIndex: run.currentStep,
            action: 'wait_started',
            message: `Waiting ${step.days} day(s).`,
          }),
        },
      });
      await options.dispatch(run.id, run.currentStep, step.days * 86_400_000);
      return run;
    }
    const elapsed = options.now.getTime() - run.waitingSince.getTime();
    if (elapsed < step.days * 86_400_000) return run;
    return advanceRun(ctx, run, `Waited ${step.days} day(s).`);
  }

  if (step.type === 'approval') {
    await ctx.db.automationRun.update({
      where: { id: run.id, workspaceId: ctx.workspaceId },
      data: {
        status: 'waiting_approval',
        waitingSince: options.now,
        log: pushLog(run, {
          at: options.now.toISOString(),
          stepIndex: run.currentStep,
          action: 'approval_requested',
          message: `Waiting for ${step.role} approval.`,
        }),
      },
    });
    return run;
  }

  if (step.type === 'send_email') {
    const template = await ctx.db.emailTemplate.findFirst({
      where: { id: step.templateId, workspaceId: ctx.workspaceId },
    });
    if (template) {
      const subject = await resolveSubject(ctx, run);
      await ctx.db.scheduledEmail.create({
        data: {
          workspaceId: ctx.workspaceId,
          type: 'automation',
          entityType:
            subjectTypeOf[run.automation.trigger as AutomationTrigger] ?? 'automation_run',
          entityId: run.subjectId,
          recipientEmail: subject?.email ?? '',
          recipientName: subject?.name ?? '',
          subject: template.subject,
          body: template.body,
          scheduledFor: options.now,
        },
      });
    }
    return advanceRun(
      ctx,
      run,
      template ? 'Email scheduled.' : 'Email template not found; skipped.'
    );
  }

  if (step.type === 'ai_draft_email') {
    return advanceRun(ctx, run, 'AI draft step skipped (no AI provider configured).');
  }

  if (step.type === 'move_deal') {
    const deal = await ctx.db.deal.findFirst({
      where: { id: run.subjectId, workspaceId: ctx.workspaceId },
    });
    // The stage must be in this workspace and on the deal's own pipeline;
    // the id was checked when the automation was saved, but the stage may
    // have been deleted or the deal moved to another pipeline since.
    const stage = deal
      ? await ctx.db.stage.findFirst({
          where: { id: step.stageId, workspaceId: ctx.workspaceId, pipelineId: deal.pipelineId },
        })
      : null;
    if (deal && stage) {
      await ctx.db.deal.update({
        where: { id: deal.id, workspaceId: ctx.workspaceId },
        data: { stageId: stage.id },
      });
    }
    return advanceRun(
      ctx,
      run,
      !deal ? 'Deal not found; skipped.' : stage ? 'Deal moved.' : 'Stage not found; skipped.'
    );
  }

  return run;
}

async function advanceRun(
  ctx: CoreContext,
  run: { id: string; currentStep: number; log: Prisma.JsonValue },
  message: string
) {
  return ctx.db.automationRun.update({
    where: { id: run.id, workspaceId: ctx.workspaceId },
    data: {
      currentStep: { increment: 1 },
      waitingSince: null,
      log: pushLog(run, {
        at: new Date().toISOString(),
        stepIndex: run.currentStep,
        action: 'step_completed',
        message,
      }),
    },
  });
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

/** Ids of runs still in progress, across workspaces, for the periodic tick. */
export async function listRunningAutomationRuns(db: Db, limit = 500): Promise<string[]> {
  const runs = await db.$unscoped.automationRun.findMany({
    where: { status: 'running' },
    select: { id: true },
    orderBy: { updatedAt: 'asc' },
    take: limit,
  });
  return runs.map((r) => r.id);
}

export async function scanAutomationTriggers(db: Db, options: { now: Date }) {
  // The scheduler runs for every workspace, so this one list is unscoped;
  // everything after it is pinned to the automation's own workspace.
  const automations = await db.$unscoped.automation.findMany({ where: { isActive: true } });
  const created: string[] = [];
  const STALL_DAYS = 7;
  const stallCutoff = new Date(options.now.getTime() - STALL_DAYS * 86_400_000);

  for (const automation of automations) {
    const subjectType = subjectTypeOf[automation.trigger as AutomationTrigger];
    if (!subjectType) continue;

    if (automation.trigger === 'invoice.overdue') {
      const subjects = await db.invoice.findMany({
        where: { workspaceId: automation.workspaceId, status: 'overdue' },
        select: { id: true },
      });
      for (const subject of subjects) {
        const existing = await db.automationRun.findFirst({
          where: {
            workspaceId: automation.workspaceId,
            automationId: automation.id,
            subjectId: subject.id,
          },
        });
        if (!existing) {
          const run = await db.automationRun.create({
            data: {
              workspaceId: automation.workspaceId,
              automationId: automation.id,
              subjectId: subject.id,
              status: 'running',
            },
          });
          created.push(run.id);
        }
      }
    }

    if (automation.trigger === 'quote.sent_no_response') {
      const subjects = await db.quote.findMany({
        where: {
          workspaceId: automation.workspaceId,
          status: 'sent',
          updatedAt: { lt: stallCutoff },
        },
        select: { id: true },
      });
      for (const subject of subjects) {
        const existing = await db.automationRun.findFirst({
          where: {
            workspaceId: automation.workspaceId,
            automationId: automation.id,
            subjectId: subject.id,
          },
        });
        if (!existing) {
          const run = await db.automationRun.create({
            data: {
              workspaceId: automation.workspaceId,
              automationId: automation.id,
              subjectId: subject.id,
              status: 'running',
            },
          });
          created.push(run.id);
        }
      }
    }

    if (automation.trigger === 'deal.stalled') {
      const subjects = await db.deal.findMany({
        where: {
          workspaceId: automation.workspaceId,
          updatedAt: { lt: stallCutoff },
        },
        select: { id: true },
      });
      for (const subject of subjects) {
        const existing = await db.automationRun.findFirst({
          where: {
            workspaceId: automation.workspaceId,
            automationId: automation.id,
            subjectId: subject.id,
          },
        });
        if (!existing) {
          const run = await db.automationRun.create({
            data: {
              workspaceId: automation.workspaceId,
              automationId: automation.id,
              subjectId: subject.id,
              status: 'running',
            },
          });
          created.push(run.id);
        }
      }
    }
  }

  return created;
}
