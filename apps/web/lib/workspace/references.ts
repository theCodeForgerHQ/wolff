import { prisma } from '@wolff/database';

/**
 * Checks that the related records a client named belong to the workspace.
 * An id is stored as given, so without this another workspace's category,
 * tax rate or project could be linked to ours, and reads that include the
 * relation would show its data. Throws a plain "not found" for any miss.
 */
export async function assertReferencesInWorkspace(
  workspaceId: string,
  refs: { categoryId?: string | null; taxRateId?: string | null; projectId?: string | null }
): Promise<void> {
  const checks: Promise<void>[] = [];
  if (refs.categoryId) {
    checks.push(
      prisma.rateCardCategory
        .findFirst({
          where: { id: refs.categoryId, workspaceId, deletedAt: null },
          select: { id: true },
        })
        .then((row) => {
          if (!row) throw new Error('Category not found');
        })
    );
  }
  if (refs.taxRateId) {
    checks.push(
      prisma.taxRate
        .findFirst({ where: { id: refs.taxRateId, workspaceId }, select: { id: true } })
        .then((row) => {
          if (!row) throw new Error('Tax rate not found');
        })
    );
  }
  if (refs.projectId) {
    checks.push(
      prisma.project
        .findFirst({
          where: { id: refs.projectId, workspaceId, deletedAt: null },
          select: { id: true },
        })
        .then((row) => {
          if (!row) throw new Error('Project not found');
        })
    );
  }
  await Promise.all(checks);
}
