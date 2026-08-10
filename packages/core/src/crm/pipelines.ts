import { CoreError } from '../errors';
import type { CoreContext, DbOrTx } from '../context';

export const DEFAULT_PIPELINE_NAME = 'Sales Pipeline';

export const DEFAULT_STAGES: Array<{
  name: string;
  position: number;
  probability: number;
  kind: 'open' | 'won' | 'lost';
}> = [
  { name: 'New', position: 0, probability: 10, kind: 'open' },
  { name: 'Qualified', position: 1, probability: 25, kind: 'open' },
  { name: 'Proposal', position: 2, probability: 50, kind: 'open' },
  { name: 'Negotiation', position: 3, probability: 75, kind: 'open' },
  { name: 'Won', position: 4, probability: 100, kind: 'won' },
  { name: 'Lost', position: 5, probability: 0, kind: 'lost' },
];

/**
 * Ensures a workspace has a default pipeline with the standard stages.
 * Called on workspace creation and by backfills. Idempotent.
 */
export async function ensureDefaultPipeline(
  db: DbOrTx,
  workspaceId: string
): Promise<{ pipelineId: string; stageIds: string[] }> {
  const existing = await db.pipeline.findFirst({
    where: { workspaceId, isDefault: true },
    include: { stages: { orderBy: { position: 'asc' } } },
  });

  if (existing) {
    return {
      pipelineId: existing.id,
      stageIds: existing.stages.map((s) => s.id),
    };
  }

  return db.$transaction(async (tx) => {
    const pipeline = await tx.pipeline.create({
      data: {
        workspaceId,
        name: DEFAULT_PIPELINE_NAME,
        isDefault: true,
        stages: {
          create: DEFAULT_STAGES.map((s) => ({
            workspaceId,
            name: s.name,
            position: s.position,
            probability: s.probability,
            kind: s.kind,
          })),
        },
      },
      include: { stages: { orderBy: { position: 'asc' } } },
    });

    return {
      pipelineId: pipeline.id,
      stageIds: pipeline.stages.map((s) => s.id),
    };
  });
}

export interface PipelineWithStages {
  id: string;
  name: string;
  isDefault: boolean;
  stages: Array<{
    id: string;
    name: string;
    position: number;
    probability: number;
    kind: string;
  }>;
}

/**
 * Replaces the stages of a pipeline in one transaction. Existing deals keep
 * their current stage unless it is removed; callers must move deals before
 * replacing stages if that is the desired behaviour.
 */
export async function replacePipelineStages(
  db: DbOrTx,
  workspaceId: string,
  pipelineId: string,
  stages: Array<{
    id?: string;
    name: string;
    position: number;
    probability: number;
    kind: 'open' | 'won' | 'lost';
  }>
): Promise<PipelineWithStages> {
  return db.$transaction(async (tx) => {
    const pipeline = await tx.pipeline.findFirstOrThrow({
      where: { id: pipelineId, workspaceId },
    });

    // Delete stages not in the new list, then recreate/update.
    const keepIds = stages.map((s) => s.id).filter(Boolean) as string[];
    await tx.stage.deleteMany({
      where: { pipelineId, workspaceId, id: { notIn: keepIds } },
    });

    for (const s of stages) {
      if (s.id) {
        await tx.stage.update({
          where: { id: s.id, pipelineId, workspaceId },
          data: {
            name: s.name,
            position: s.position,
            probability: s.probability,
            kind: s.kind,
          },
        });
      } else {
        await tx.stage.create({
          data: {
            workspaceId,
            pipelineId: pipeline.id,
            name: s.name,
            position: s.position,
            probability: s.probability,
            kind: s.kind,
          },
        });
      }
    }

    return tx.pipeline.findUniqueOrThrow({
      where: { id: pipeline.id, workspaceId },
      include: { stages: { orderBy: { position: 'asc' } } },
    });
  });
}

export interface CreatePipelineInput {
  name: string;
  stages: Array<{
    name: string;
    position: number;
    probability: number;
    kind: 'open' | 'won' | 'lost';
  }>;
}

export async function listPipelines(ctx: CoreContext) {
  const { db, workspaceId } = ctx;
  const pipelines = await db.pipeline.findMany({
    where: { workspaceId },
    include: { stages: { orderBy: { position: 'asc' } } },
    orderBy: { createdAt: 'asc' },
  });
  if (pipelines.length === 0) {
    await ensureDefaultPipeline(db, workspaceId);
    return db.pipeline.findMany({
      where: { workspaceId },
      include: { stages: { orderBy: { position: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    });
  }
  return pipelines;
}

export async function getPipeline(ctx: CoreContext, id: string) {
  const { db, workspaceId } = ctx;
  const pipeline = await db.pipeline.findFirst({
    where: { id, workspaceId },
    include: { stages: { orderBy: { position: 'asc' } } },
  });
  if (!pipeline) {
    await ensureDefaultPipeline(db, workspaceId);
    return db.pipeline.findFirst({
      where: { id, workspaceId },
      include: { stages: { orderBy: { position: 'asc' } } },
    });
  }
  return pipeline;
}

export async function createPipeline(ctx: CoreContext, input: CreatePipelineInput) {
  const { db, workspaceId } = ctx;
  return db.pipeline.create({
    data: {
      workspaceId,
      name: input.name,
      stages: {
        create: input.stages.map((s) => ({
          workspaceId,
          name: s.name,
          position: s.position,
          probability: s.probability,
          kind: s.kind,
        })),
      },
    },
    include: { stages: { orderBy: { position: 'asc' } } },
  });
}

export interface UpdatePipelineInput {
  name?: string;
  isDefault?: boolean;
}

export async function updatePipeline(ctx: CoreContext, id: string, input: UpdatePipelineInput) {
  const { db, workspaceId } = ctx;
  const existing = await db.pipeline.findFirst({ where: { id, workspaceId } });
  if (!existing) return null;

  return db.$transaction(async (tx) => {
    if (input.isDefault && !existing.isDefault) {
      await tx.pipeline.updateMany({
        where: { workspaceId, isDefault: true },
        data: { isDefault: false },
      });
    }
    return tx.pipeline.update({
      where: { id, workspaceId },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.isDefault !== undefined && { isDefault: input.isDefault }),
      },
      include: { stages: { orderBy: { position: 'asc' } } },
    });
  });
}

export async function replaceStages(
  ctx: CoreContext,
  pipelineId: string,
  stages: Array<{
    id?: string;
    name: string;
    position: number;
    probability: number;
    kind: 'open' | 'won' | 'lost';
  }>
) {
  const { db, workspaceId } = ctx;
  const pipeline = await getPipeline(ctx, pipelineId);
  if (!pipeline) throw new CoreError('not_found', 'Pipeline not found');
  return replacePipelineStages(db, workspaceId, pipelineId, stages);
}
