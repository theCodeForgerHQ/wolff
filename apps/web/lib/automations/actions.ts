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
import { ROUTES } from '@/lib/routes';
import type { AutomationFormInput, AutomationListItem, AutomationRunListItem } from './types';

const db = withTenantGuard(prisma);

async function getContext() {
  const { workspaceId, userId } = await getCurrentUserWorkspace();
  return { db, workspaceId, actorId: userId };
}

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
    automationName: (r.automation as { name: string }).name,
    trigger: (r.automation as { trigger: string }).trigger,
    subjectId: r.subjectId,
    currentStep: r.currentStep,
    status: r.status,
    log: Array.isArray(r.log) ? (r.log as any[]) : [],
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export async function createAutomation(input: AutomationFormInput) {
  const ctx = await getContext();
  const parsed = createAutomationSchema.parse(input);
  const automation = await createAutomationCore(ctx, parsed);
  revalidatePath(ROUTES.automations);
  return automation;
}

export async function updateAutomation(id: string, input: Partial<AutomationFormInput>) {
  const ctx = await getContext();
  const parsed = updateAutomationSchema.parse(input);
  const automation = await updateAutomationCore(ctx, id, parsed);
  if (!automation) throw new Error('Automation not found');
  revalidatePath(ROUTES.automations);
  return automation;
}

export async function deleteAutomation(id: string) {
  const ctx = await getContext();
  const automation = await deleteAutomationCore(ctx, id);
  if (!automation) throw new Error('Automation not found');
  revalidatePath(ROUTES.automations);
  return automation;
}

export async function approveRun(id: string) {
  const ctx = await getContext();
  const run = await approveRunCore(ctx, id, true);
  if (!run) throw new Error('Run not found or not waiting for approval');
  revalidatePath(ROUTES.automations);
  return run;
}

export async function rejectRun(id: string) {
  const ctx = await getContext();
  const run = await approveRunCore(ctx, id, false);
  if (!run) throw new Error('Run not found or not waiting for approval');
  revalidatePath(ROUTES.automations);
  return run;
}
