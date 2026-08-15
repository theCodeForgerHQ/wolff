'use server';

import { revalidatePath } from 'next/cache';
import { prisma, withTenantGuard } from '@wolff/database';
import { getCurrentUserWorkspace } from '@/lib/workspace/get-current-workspace';
import {
  createAutomation as createAutomationCore,
  updateAutomation as updateAutomationCore,
  deleteAutomation as deleteAutomationCore,
  listAutomations as listAutomationsCore,
  listAutomationRuns as listAutomationRunsCore,
  approveRun as approveRunCore,
} from '@wolff/core/automations';
import {
  createAutomationSchema,
  updateAutomationSchema,
  type AutomationStep,
} from '@wolff/contracts';
import { ZodError } from 'zod';
import { CoreError } from '@wolff/core/errors';
import { ROUTES } from '@/lib/routes';
import type {
  AutomationFormInput,
  AutomationListItem,
  AutomationOptions,
  AutomationRunListItem,
} from './types';

const db = withTenantGuard(prisma);

async function getContext() {
  const { workspaceId, userId, role } = await getCurrentUserWorkspace();
  return { db, workspaceId, actorId: userId, role };
}

/**
 * An automation emails clients and moves deals on its own, so changing one
 * is workspace configuration: owners and admins only, as for API keys.
 */
async function getEditorContext() {
  const { role, ...ctx } = await getContext();
  if (role !== 'owner' && role !== 'admin') return null;
  return ctx;
}

const NOT_ALLOWED: ActionResult = {
  success: false,
  error: 'Only an owner or admin can change automations',
};

export async function getAutomations(): Promise<AutomationListItem[]> {
  const ctx = await getContext();
  const page = await listAutomationsCore(ctx, { limit: 100 });
  return page.data.map((a) => ({
    id: a.id,
    name: a.name,
    trigger: a.trigger,
    isActive: a.isActive,
    stepCount: Array.isArray(a.steps) ? a.steps.length : 0,
    steps: Array.isArray(a.steps) ? (a.steps as AutomationStep[]) : [],
    createdAt: a.createdAt,
  }));
}

export async function getAutomationRuns(status?: string): Promise<AutomationRunListItem[]> {
  const ctx = await getContext();
  const page = await listAutomationRunsCore(ctx, {
    limit: 100,
    filters: status ? { status: status as any } : undefined,
  });
  return page.data.map((r) => ({
    id: r.id,
    automationId: r.automationId,
    automationName: (r.automation as { name: string } | null)?.name ?? 'Unknown automation',
    trigger: (r.automation as { trigger: string } | null)?.trigger ?? 'invoice.overdue',
    subjectId: r.subjectId,
    currentStep: r.currentStep,
    status: r.status,
    log: Array.isArray(r.log) ? (r.log as any[]) : [],
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export async function getAutomationOptions(): Promise<AutomationOptions> {
  const { workspaceId } = await getContext();
  const [templates, stages] = await Promise.all([
    db.emailTemplate.findMany({
      where: { workspaceId, isActive: true, deletedAt: null },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    db.stage.findMany({
      where: { workspaceId },
      select: { id: true, name: true, pipeline: { select: { name: true } } },
      orderBy: [{ pipelineId: 'asc' }, { position: 'asc' }],
    }),
  ]);
  return {
    templates,
    stages: stages.map((s) => ({ id: s.id, name: s.name, pipelineName: s.pipeline.name })),
  };
}

/** Server actions answer with a result: a thrown error's message is hidden in production. */
export type ActionResult = { success: true } | { success: false; error: string };

async function attempt(work: () => Promise<unknown>): Promise<ActionResult> {
  try {
    await work();
    revalidatePath(ROUTES.automations);
    return { success: true };
  } catch (error) {
    if (error instanceof CoreError) {
      const reasons = error.details ? Object.values(error.details).flat() : [];
      return { success: false, error: [error.message, ...reasons].join(': ') };
    }
    if (error instanceof ZodError) return { success: false, error: 'Some fields are not valid' };
    throw error;
  }
}

export async function createAutomation(input: AutomationFormInput): Promise<ActionResult> {
  const ctx = await getEditorContext();
  if (!ctx) return NOT_ALLOWED;
  return attempt(() => createAutomationCore(ctx, createAutomationSchema.parse(input)));
}

export async function updateAutomation(
  id: string,
  input: Partial<AutomationFormInput>
): Promise<ActionResult> {
  const ctx = await getEditorContext();
  if (!ctx) return NOT_ALLOWED;
  return attempt(async () => {
    const automation = await updateAutomationCore(ctx, id, updateAutomationSchema.parse(input));
    if (!automation) throw new CoreError('not_found', 'Automation not found');
  });
}

export async function deleteAutomation(id: string): Promise<ActionResult> {
  const ctx = await getEditorContext();
  if (!ctx) return NOT_ALLOWED;
  return attempt(async () => {
    if (!(await deleteAutomationCore(ctx, id))) {
      throw new CoreError('not_found', 'Automation not found');
    }
  });
}

/** Approve or reject a run waiting at an approval step (role-checked in core). */
export async function decideRun(id: string, approved: boolean): Promise<ActionResult> {
  const ctx = await getContext();
  return attempt(async () => {
    if (!(await approveRunCore(ctx, id, approved))) {
      throw new CoreError('conflict', 'This run is no longer waiting for approval');
    }
  });
}
