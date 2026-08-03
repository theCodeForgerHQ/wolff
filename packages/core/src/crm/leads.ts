import type { CoreContext, DbOrTx } from '../context';
import { ensureDefaultPipeline } from './pipelines';

export interface ConvertLeadInput {
  leadId: string;
  /** Override the deal title; defaults to the lead's company or name. */
  title?: string;
  /** Override the deal value; defaults to 0. */
  value?: number;
  /** Override the deal currency; defaults to the workspace currency or USD. */
  currency?: string;
  /** Place the new deal in this stage; defaults to the first open stage. */
  stageId?: string;
}

export interface ConvertLeadResult {
  clientId: string;
  dealId: string;
  leadId: string;
}

/**
 * Converts a lead into a client and a deal in the workspace's default
 * pipeline. The lead is marked converted and linked to the new client.
 * Idempotent: converting the same lead twice returns the existing client and
 * deal.
 */
export async function convertLead(
  ctx: CoreContext,
  input: ConvertLeadInput
): Promise<ConvertLeadResult> {
  const { db, workspaceId, actorId } = ctx;

  const existing = await db.lead.findFirst({
    where: { id: input.leadId, workspaceId, deletedAt: null },
    include: { deal: true, client: true },
  });
  if (!existing) throw new Error('Lead not found');
  if (existing.status === 'converted' && existing.deal && existing.client) {
    return {
      clientId: existing.client.id,
      dealId: existing.deal.id,
      leadId: existing.id,
    };
  }

  const { pipelineId, stageIds } = await ensureDefaultPipeline(db, workspaceId);

  // Pick the target stage: explicit, or the first open stage, or the first
  // stage as a fallback.
  const stages = await db.stage.findMany({
    where: { pipelineId },
    orderBy: { position: 'asc' },
  });
  const targetStage = input.stageId
    ? stages.find((s) => s.id === input.stageId)
    : (stages.find((s) => s.kind === 'open') ?? stages[0]);
  if (!targetStage) throw new Error('Pipeline has no stages');

  return db.$transaction(async (tx) => {
    // Lock the lead so concurrent conversions do not create duplicates.
    const [locked] = await tx.$queryRaw<{ id: string; status: string }[]>`
      SELECT id, status::text FROM leads
      WHERE id = ${input.leadId} AND workspace_id = ${workspaceId} AND deleted_at IS NULL
      FOR UPDATE`;
    if (!locked) throw new Error('Lead not found');
    if (locked.status === 'converted') {
      const converted = await tx.lead.findUniqueOrThrow({
        where: { id: input.leadId },
        include: { deal: true, client: true },
      });
      if (converted.client && converted.deal) {
        return {
          clientId: converted.client.id,
          dealId: converted.deal.id,
          leadId: converted.id,
        };
      }
    }

    const workspace = await tx.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      include: { businessProfile: true },
    });

    const client = await tx.client.create({
      data: {
        workspaceId,
        name: existing.name,
        company: existing.company ?? undefined,
        email: existing.email ?? `${existing.id}@lead.local`,
        phone: existing.phone ?? undefined,
        countryCode: workspace.businessProfile?.gstin ? 'IN' : 'US',
      },
    });

    const deal = await tx.deal.create({
      data: {
        workspaceId,
        pipelineId,
        stageId: targetStage.id,
        leadId: existing.id,
        clientId: client.id,
        title:
          input.title ?? (existing.company ? `${existing.company} deal` : `${existing.name} deal`),
        value: input.value ?? 0,
        currency: input.currency ?? workspace.businessProfile?.currency ?? 'USD',
        ownerId: existing.ownerId ?? actorId,
      },
    });

    await tx.lead.update({
      where: { id: existing.id },
      data: {
        status: 'converted',
        clientId: client.id,
        convertedAt: new Date(),
      },
    });

    await tx.dealActivity.create({
      data: {
        workspaceId,
        dealId: deal.id,
        type: 'stage_changed',
        actorId,
        payload: {
          fromStageId: null,
          toStageId: targetStage.id,
          source: 'lead_conversion',
        },
      },
    });

    return { clientId: client.id, dealId: deal.id, leadId: existing.id };
  });
}
