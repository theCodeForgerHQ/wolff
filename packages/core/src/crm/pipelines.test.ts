import { afterAll, describe, expect, it } from 'vitest';
import { createPrisma, withTenantGuard } from '@wolff/database';
import type { CoreContext } from '../context';
import { CoreError } from '../errors';
import {
  createPipeline,
  ensureDefaultPipeline,
  getPipeline,
  listPipelines,
  replaceStages,
  updatePipeline,
} from './pipelines';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('pipelines', () => {
  const base = createPrisma(url!);
  const db = withTenantGuard(base, { mode: 'throw' });
  const workspaces: string[] = [];

  async function workspace(): Promise<CoreContext> {
    const ws = await base.workspace.create({
      data: { name: 'Pipelines', slug: `pipelines-${Date.now()}-${workspaces.length}` },
    });
    workspaces.push(ws.id);
    return { db, workspaceId: ws.id };
  }

  const stage = (name: string, position: number, kind: 'open' | 'won' | 'lost' = 'open') => ({
    name,
    position,
    probability: kind === 'won' ? 100 : 10,
    kind,
  });

  afterAll(async () => {
    await base.deal.deleteMany({ where: { workspaceId: { in: workspaces } } });
    await base.stage.deleteMany({ where: { workspaceId: { in: workspaces } } });
    await base.pipeline.deleteMany({ where: { workspaceId: { in: workspaces } } });
    await base.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await base.$disconnect();
  });

  it('creates the default pipeline on first list, and only once', async () => {
    const ctx = await workspace();

    const first = await listPipelines(ctx);
    const second = await listPipelines(ctx);

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ name: 'Sales Pipeline', isDefault: true });
    expect(first[0]!.stages.map((s) => s.name)).toEqual([
      'New',
      'Qualified',
      'Proposal',
      'Negotiation',
      'Won',
      'Lost',
    ]);
    expect(second.map((p) => p.id)).toEqual(first.map((p) => p.id));
  });

  it("does not return another workspace's pipeline", async () => {
    const a = await workspace();
    const b = await workspace();
    const { pipelineId } = await ensureDefaultPipeline(db, a.workspaceId);

    expect(await getPipeline(b, pipelineId)).toBeNull();
    expect((await getPipeline(a, pipelineId))?.id).toBe(pipelineId);
  });

  it('creates a pipeline with its stages in position order, not as default', async () => {
    const ctx = await workspace();

    const created = await createPipeline(ctx, {
      name: 'Hiring',
      stages: [stage('Offer', 1), stage('Applied', 0), stage('Hired', 2, 'won')],
    });

    expect(created.isDefault).toBe(false);
    expect(created.stages.map((s) => s.name)).toEqual(['Applied', 'Offer', 'Hired']);
  });

  it('makes a pipeline the default and the previous default not', async () => {
    const ctx = await workspace();
    const { pipelineId: oldDefault } = await ensureDefaultPipeline(db, ctx.workspaceId);
    const other = await createPipeline(ctx, { name: 'Other', stages: [stage('A', 0)] });

    const updated = await updatePipeline(ctx, other.id, { isDefault: true, name: 'Main' });

    expect(updated).toMatchObject({ id: other.id, name: 'Main', isDefault: true });
    const old = await base.pipeline.findUniqueOrThrow({ where: { id: oldDefault } });
    expect(old.isDefault).toBe(false);
  });

  it('renames without touching the default flag, and answers null for a foreign pipeline', async () => {
    const a = await workspace();
    const b = await workspace();
    const { pipelineId } = await ensureDefaultPipeline(db, a.workspaceId);

    expect(await updatePipeline(b, pipelineId, { name: 'Stolen' })).toBeNull();
    const renamed = await updatePipeline(a, pipelineId, { name: 'Renamed' });
    expect(renamed).toMatchObject({ name: 'Renamed', isDefault: true });
  });

  it('replaces stages: keeps listed ones, adds new ones, removes the rest', async () => {
    const ctx = await workspace();
    const pipeline = await createPipeline(ctx, {
      name: 'P',
      stages: [stage('A', 0), stage('B', 1), stage('C', 2)],
    });
    const [a, , c] = pipeline.stages;

    const result = await replaceStages(ctx, pipeline.id, [
      { ...stage('A renamed', 0), id: a!.id },
      { ...stage('C', 1, 'won'), id: c!.id },
      stage('D', 2, 'lost'),
    ]);

    expect(result.stages.map((s) => [s.name, s.position, s.kind])).toEqual([
      ['A renamed', 0, 'open'],
      ['C', 1, 'won'],
      ['D', 2, 'lost'],
    ]);
    expect(result.stages[0]!.id).toBe(a!.id);
    expect(result.stages[1]!.id).toBe(c!.id);
  });

  it('swaps the positions of two stages', async () => {
    const ctx = await workspace();
    const pipeline = await createPipeline(ctx, {
      name: 'P',
      stages: [stage('A', 0), stage('B', 1)],
    });
    const [a, b] = pipeline.stages;

    const result = await replaceStages(ctx, pipeline.id, [
      { ...stage('B', 0), id: b!.id },
      { ...stage('A', 1), id: a!.id },
    ]);

    expect(result.stages.map((s) => s.name)).toEqual(['B', 'A']);
  });

  it('refuses to remove a stage that still holds deals, and changes nothing', async () => {
    const ctx = await workspace();
    const pipeline = await createPipeline(ctx, {
      name: 'P',
      stages: [stage('A', 0), stage('B', 1)],
    });
    const [a, b] = pipeline.stages;
    await base.deal.create({
      data: {
        workspaceId: ctx.workspaceId,
        pipelineId: pipeline.id,
        stageId: b!.id,
        title: 'Held',
        value: 10,
      },
    });

    const attempt = replaceStages(ctx, pipeline.id, [{ ...stage('A2', 0), id: a!.id }]);

    await expect(attempt).rejects.toMatchObject({ code: 'conflict' });
    const stages = await base.stage.findMany({ where: { pipelineId: pipeline.id } });
    expect(stages.map((s) => s.name).sort()).toEqual(['A', 'B']);
  });

  it("refuses a stage id that is not in the pipeline (another pipeline's or workspace's)", async () => {
    const a = await workspace();
    const b = await workspace();
    const mine = await createPipeline(a, { name: 'Mine', stages: [stage('A', 0)] });
    const theirs = await createPipeline(b, { name: 'Theirs', stages: [stage('X', 0)] });

    const attempt = replaceStages(a, mine.id, [{ ...stage('X', 0), id: theirs.stages[0]!.id }]);

    await expect(attempt).rejects.toBeInstanceOf(CoreError);
    await expect(attempt).rejects.toMatchObject({ code: 'not_found' });
    const untouched = await base.stage.findUniqueOrThrow({ where: { id: theirs.stages[0]!.id } });
    expect(untouched.name).toBe('X');
  });

  it("refuses to replace the stages of another workspace's pipeline", async () => {
    const a = await workspace();
    const b = await workspace();
    const theirs = await createPipeline(b, { name: 'Theirs', stages: [stage('X', 0)] });

    await expect(replaceStages(a, theirs.id, [stage('Mine', 0)])).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
