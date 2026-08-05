import { describe, expect, it, beforeEach } from 'vitest';
import { createPrisma, withTenantGuard } from '@wolff/database';
import type { CoreContext } from '../context';
import { ensureDefaultPipeline, convertLead, moveDeal, createDeal } from '.';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('CRM core', () => {
  const base = createPrisma(url!);
  const db = withTenantGuard(base, { mode: 'throw' });
  const ctx = (workspaceId: string, actorId?: string): CoreContext => ({
    db,
    workspaceId,
    actorId,
  });

  beforeEach(async () => {
    await base.$transaction([
      base.dealActivity.deleteMany(),
      base.deal.deleteMany(),
      base.lead.deleteMany(),
      base.stage.deleteMany(),
      base.pipeline.deleteMany(),
    ]);
  });

  async function setupWorkspace() {
    const user = await base.user.create({
      data: { email: `crm-test-${Date.now()}@example.com`, name: 'Tester' },
    });
    const workspace = await base.workspace.create({
      data: {
        name: 'CRM Test Workspace',
        slug: `crm-test-${Date.now()}`,
        ownerId: user.id,
        businessProfile: { create: { businessName: 'Test Co', currency: 'INR' } },
      },
    });
    return { user, workspace };
  }

  it('creates a default pipeline with six stages', async () => {
    const { workspace } = await setupWorkspace();
    const { pipelineId, stageIds } = await ensureDefaultPipeline(db, workspace.id);
    expect(pipelineId).toBeTruthy();
    expect(stageIds).toHaveLength(6);

    const pipeline = await base.pipeline.findUniqueOrThrow({
      where: { id: pipelineId },
      include: { stages: { orderBy: { position: 'asc' } } },
    });
    expect(pipeline.stages[0]?.name).toBe('New');
    expect(pipeline.stages[4]?.name).toBe('Won');
    expect(pipeline.stages[4]?.kind).toBe('won');
    expect(pipeline.stages[5]?.kind).toBe('lost');
  });

  it('is idempotent when a default pipeline already exists', async () => {
    const { workspace } = await setupWorkspace();
    const first = await ensureDefaultPipeline(db, workspace.id);
    const second = await ensureDefaultPipeline(db, workspace.id);
    expect(first.pipelineId).toBe(second.pipelineId);
    expect(second.stageIds).toHaveLength(6);
  });

  it('converts a lead into a client and a deal', async () => {
    const { workspace, user } = await setupWorkspace();
    const lead = await base.lead.create({
      data: {
        workspaceId: workspace.id,
        name: 'Ravi Kumar',
        email: 'ravi@example.com',
        company: 'Kaveri Studio',
        source: 'widget',
      },
    });

    const result = await convertLead(ctx(workspace.id, user.id), {
      leadId: lead.id,
      value: 50000,
      currency: 'INR',
    });

    expect(result.clientId).toBeTruthy();
    expect(result.dealId).toBeTruthy();

    const updated = await base.lead.findUniqueOrThrow({
      where: { id: lead.id },
      include: { client: true, deal: true },
    });
    expect(updated.status).toBe('converted');
    expect(updated.client?.name).toBe('Ravi Kumar');
    expect(updated.deal?.title).toBe('Kaveri Studio deal');
    expect(updated.deal?.value.toNumber()).toBe(50000);
  });

  it('is idempotent when converting the same lead twice', async () => {
    const { workspace, user } = await setupWorkspace();
    const lead = await base.lead.create({
      data: {
        workspaceId: workspace.id,
        name: 'Ravi Kumar',
        email: 'ravi2@example.com',
      },
    });

    const first = await convertLead(ctx(workspace.id, user.id), { leadId: lead.id });
    const second = await convertLead(ctx(workspace.id, user.id), { leadId: lead.id });

    expect(first.clientId).toBe(second.clientId);
    expect(first.dealId).toBe(second.dealId);
  });

  it('moves a deal to a won stage and records activity', async () => {
    const { workspace, user } = await setupWorkspace();
    const client = await base.client.create({
      data: { workspaceId: workspace.id, name: 'Client', email: 'client@example.com' },
    });
    const { pipelineId } = await ensureDefaultPipeline(db, workspace.id);
    const stages = await base.stage.findMany({
      where: { pipelineId },
      orderBy: { position: 'asc' },
    });
    const openStage = stages.find((s) => s.name === 'Qualified')!;
    const wonStage = stages.find((s) => s.kind === 'won')!;

    const deal = await createDeal(ctx(workspace.id, user.id), {
      pipelineId,
      stageId: openStage.id,
      clientId: client.id,
      title: 'Big Deal',
      value: 100000,
      currency: 'INR',
    });

    const result = await moveDeal(ctx(workspace.id, user.id), {
      dealId: deal.dealId,
      stageId: wonStage.id,
    });

    expect(result.previousStageId).toBe(openStage.id);
    expect(result.newStageId).toBe(wonStage.id);
    expect(result.wonAt).toBeInstanceOf(Date);

    const activities = await base.dealActivity.findMany({
      where: { dealId: deal.dealId },
    });
    expect(activities.some((a) => a.type === 'stage_changed')).toBe(true);
  });
});
