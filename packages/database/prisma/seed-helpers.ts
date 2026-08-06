import type { PrismaClient } from '../src/generated/prisma';

/**
 * Upsert a NumberSequence row for a non-GST workspace (financialYear = null).
 * Prisma's generated compound-key input does not allow null in
 * `workspaceId_type_financialYear`, so we find by the nullable field and
 * update by id.
 */
export async function upsertNumberSequence(
  prisma: PrismaClient,
  input: {
    workspaceId: string;
    type: string;
    prefix?: string;
    suffix?: string;
    currentValue?: number;
    padding?: number;
  }
): Promise<void> {
  const existing = await prisma.numberSequence.findFirst({
    where: { workspaceId: input.workspaceId, type: input.type, financialYear: null },
  });

  const data = {
    ...(input.prefix !== undefined && { prefix: input.prefix }),
    ...(input.suffix !== undefined && { suffix: input.suffix }),
    ...(input.currentValue !== undefined && { currentValue: input.currentValue }),
    ...(input.padding !== undefined && { padding: input.padding }),
  };

  if (existing) {
    await prisma.numberSequence.update({ where: { id: existing.id }, data });
  } else {
    await prisma.numberSequence.create({
      data: { ...input, financialYear: null },
    });
  }
}
