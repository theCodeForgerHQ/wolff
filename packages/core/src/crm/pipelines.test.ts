import { afterAll, describe, expect, it } from 'vitest';
import { createPrisma, withTenantGuard } from '@wolff/database';
import type { CoreContext } from '../context';
import { createPipeline, replaceStages } from './pipelines';

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
});
