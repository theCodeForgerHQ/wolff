import { CoreError } from '../errors';
import type { CoreContext, DbOrTx } from '../context';
import { afterCursor, toCursorPage, type CursorPosition } from '../pagination';

export interface MoveDealInput {
  dealId: string;
  stageId: string;
  /** Optional fractional position within the stage for Kanban ordering. */
  position?: number;
  lostReason?: string;
}

export interface MoveDealResult {
  dealId: string;
  previousStageId: string;
  newStageId: string;
  wonAt: Date | null;
  lostAt: Date | null;
}

/**
 * Moves a deal to a new stage, recording the activity and setting won/lost
 * timestamps when the target stage is terminal. The move is scoped to the
 * workspace and the target stage must belong to the same pipeline.
 */
export async function moveDeal(ctx: CoreContext, input: MoveDealInput): Promise<MoveDealResult> {
  const { db, workspaceId, actorId } = ctx;

  return db.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<
      Array<{ id: string; stage_id: string; pipeline_id: string }>
    >`
      SELECT id, stage_id, pipeline_id FROM deals
      WHERE id = ${input.dealId} AND workspace_id = ${workspaceId} AND deleted_at IS NULL
      FOR UPDATE`;
    if (!locked) throw new Error('Deal not found');

    const targetStage = await tx.stage.findFirst({
      where: { id: input.stageId, pipelineId: locked.pipeline_id, workspaceId },
    });
    if (!targetStage) throw new Error('Target stage not found in deal pipeline');

    const previousStageId = locked.stage_id;
    const now = new Date();
    const isWon = targetStage.kind === 'won';
    const isLost = targetStage.kind === 'lost';

    const updateData: Record<string, unknown> = {
      stageId: targetStage.id,
      updatedAt: now,
    };
    if (input.position !== undefined) updateData.position = input.position;
    if (isWon) {
      updateData.wonAt = now;
      updateData.lostAt = null;
      updateData.lostReason = null;
    } else if (isLost) {
      updateData.lostAt = now;
      updateData.wonAt = null;
      if (input.lostReason) updateData.lostReason = input.lostReason;
    } else {
      updateData.wonAt = null;
      updateData.lostAt = null;
    }

    await tx.deal.update({
      where: { id: input.dealId, workspaceId },
      data: updateData,
    });

    await tx.dealActivity.create({
      data: {
        workspaceId,
        dealId: input.dealId,
        type: 'stage_changed',
        actorId,
        payload: {
          fromStageId: previousStageId,
          toStageId: targetStage.id,
          toStageKind: targetStage.kind,
          lostReason: input.lostReason ?? null,
        },
      },
    });

    return {
      dealId: input.dealId,
      previousStageId,
      newStageId: targetStage.id,
      wonAt: isWon ? now : null,
      lostAt: isLost ? now : null,
    };
  });
}

export interface CreateDealInput {
  pipelineId: string;
  stageId: string;
  clientId?: string;
  leadId?: string;
  title: string;
  value?: number;
  currency?: string;
  expectedCloseDate?: Date;
  ownerId?: string;
}

/**
 * Creates a deal directly (not from a lead). The stage must belong to the
 * pipeline, and either a client or lead must be provided.
 */
export async function createDeal(
  ctx: CoreContext,
  input: CreateDealInput
): Promise<{ dealId: string }> {
  const { db, workspaceId, actorId } = ctx;

  if (!input.clientId && !input.leadId) {
    throw new Error('Either clientId or leadId is required');
  }

  const stage = await db.stage.findFirst({
    where: { id: input.stageId, pipelineId: input.pipelineId, workspaceId },
  });
  if (!stage) throw new Error('Stage not found in pipeline');

  const deal = await db.deal.create({
    data: {
      workspaceId,
      pipelineId: input.pipelineId,
      stageId: input.stageId,
      clientId: input.clientId,
      leadId: input.leadId,
      title: input.title,
      value: input.value ?? 0,
      currency: input.currency ?? 'USD',
      expectedCloseDate: input.expectedCloseDate,
      ownerId: input.ownerId ?? null,
    },
  });

  await db.dealActivity.create({
    data: {
      workspaceId,
      dealId: deal.id,
      type: 'stage_changed',
      actorId,
      payload: {
        fromStageId: null,
        toStageId: input.stageId,
        source: 'deal_created',
      },
    },
  });

  return { dealId: deal.id };
}

export interface ListDealsQuery {
  limit: number;
  cursor?: string;
}

export async function listDeals(ctx: CoreContext, query: ListDealsQuery) {
  const { db, workspaceId } = ctx;
  const limit = Math.min(query.limit, 100);

  const rows = await db.deal.findMany({
    where: { workspaceId, deletedAt: null, ...afterCursor(query.cursor) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });

  return toCursorPage(rows, limit);
}

export async function getDeal(ctx: CoreContext, id: string) {
  const { db, workspaceId } = ctx;
  return db.deal.findFirst({
    where: { id, workspaceId, deletedAt: null },
  });
}

export interface UpdateDealInput {
  title?: string;
  stageId?: string;
  value?: number;
  currency?: string;
  expectedCloseDate?: Date | null;
  ownerId?: string | null;
}

export async function updateDeal(ctx: CoreContext, id: string, input: UpdateDealInput) {
  const { db, workspaceId } = ctx;
  const existing = await db.deal.findFirst({ where: { id, workspaceId, deletedAt: null } });
  if (!existing) return null;

  if (input.stageId) {
    const stage = await db.stage.findFirst({
      where: { id: input.stageId, pipelineId: existing.pipelineId, workspaceId },
    });
    if (!stage) throw new CoreError('not_found', 'Stage not found in pipeline');
  }

  return db.deal.update({
    where: { id, workspaceId },
    data: {
      ...(input.title !== undefined && { title: input.title }),
      ...(input.stageId !== undefined && { stageId: input.stageId }),
      ...(input.value !== undefined && { value: input.value }),
      ...(input.currency !== undefined && { currency: input.currency }),
      ...(input.expectedCloseDate !== undefined && {
        expectedCloseDate: input.expectedCloseDate,
      }),
      ...(input.ownerId !== undefined && { ownerId: input.ownerId }),
    },
  });
}

export async function deleteDeal(ctx: CoreContext, id: string) {
  const { db, workspaceId } = ctx;
  const existing = await db.deal.findFirst({ where: { id, workspaceId, deletedAt: null } });
  if (!existing) return false;

  await db.deal.update({ where: { id, workspaceId }, data: { deletedAt: new Date() } });
  return true;
}
