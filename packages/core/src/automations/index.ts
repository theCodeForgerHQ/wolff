import type { AutomationStep, AutomationTrigger } from '@wolff/contracts';
import type { Prisma } from '@wolff/database';
import type { CoreContext, DbOrTx } from '../context';
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

export async function createAutomation(ctx: CoreContext, input: CreateAutomationInput) {
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
  return ctx.db.automation.update({
    where: { id },
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
  await ctx.db.automation.delete({ where: { id } });
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
}

function pushLog(run: { log: Prisma.JsonValue }, entry: LogEntry): Prisma.InputJsonValue {
  const existing = Array.isArray(run.log) ? (run.log as unknown as LogEntry[]) : [];
  return [...existing, entry] as unknown as Prisma.InputJsonValue;
}

export async function approveRun(ctx: CoreContext, id: string, approved: boolean) {
  const run = await ctx.db.automationRun.findFirst({
    where: { id, workspaceId: ctx.workspaceId, status: 'waiting_approval' },
  });
  if (!run) return null;

  if (!approved) {
    return ctx.db.automationRun.update({
      where: { id },
      data: {
        status: 'cancelled',
        log: pushLog(run, {
          at: new Date().toISOString(),
          stepIndex: run.currentStep,
          action: 'approval_rejected',
          message: 'Run rejected by user.',
        }),
      },
    });
  }

  return ctx.db.automationRun.update({
    where: { id },
    data: {
      status: 'running',
      waitingSince: null,
      currentStep: { increment: 1 },
      log: pushLog(run, {
        at: new Date().toISOString(),
        stepIndex: run.currentStep,
        action: 'approval_approved',
        message: 'Approved; continuing.',
      }),
    },
  });
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
      where: { id: run.id },
      data: { status: 'done' },
    });
  }

  const step = steps[run.currentStep];
  if (!step) return run;

  if (step.type === 'wait') {
    if (!run.waitingSince) {
      await ctx.db.automationRun.update({
        where: { id: run.id },
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
      where: { id: run.id },
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
      const subject = await resolveSubject(ctx.db, run);
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
    if (deal) {
      await ctx.db.deal.update({
        where: { id: deal.id, workspaceId: ctx.workspaceId },
        data: { stageId: step.stageId },
      });
    }
    return advanceRun(ctx, run, deal ? 'Deal moved.' : 'Deal not found; skipped.');
  }

  return run;
}

async function advanceRun(
  ctx: CoreContext,
  run: { id: string; currentStep: number; log: Prisma.JsonValue },
  message: string
) {
  return ctx.db.automationRun.update({
    where: { id: run.id },
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
  db: DbOrTx,
  run: { subjectId: string; automation: { trigger: string } }
): Promise<{ name: string | null; email: string | null } | null> {
  const trigger = run.automation.trigger as AutomationTrigger;
  if (trigger === 'invoice.overdue') {
    const invoice = await db.invoice.findFirst({
      where: { id: run.subjectId },
      include: { client: { select: { name: true, email: true } } },
    });
    return invoice?.client ?? null;
  }
  if (trigger === 'quote.sent_no_response') {
    const quote = await db.quote.findFirst({
      where: { id: run.subjectId },
      include: { client: { select: { name: true, email: true } } },
    });
    return quote?.client ?? null;
  }
  if (trigger === 'deal.stalled') {
    const deal = await db.deal.findFirst({
      where: { id: run.subjectId },
      include: {
        lead: { select: { name: true, email: true } },
        client: { select: { name: true, email: true } },
      },
    });
    return deal?.client ?? deal?.lead ?? null;
  }
  return null;
}

export async function scanAutomationTriggers(db: DbOrTx, options: { now: Date }) {
  const automations = await db.automation.findMany({ where: { isActive: true } });
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
          where: { automationId: automation.id, subjectId: subject.id },
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
          where: { automationId: automation.id, subjectId: subject.id },
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
          where: { automationId: automation.id, subjectId: subject.id },
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
