// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ids a client sends for related records (a rate card's category and tax
 * rate, a quote's project) were stored as given. Another workspace's id
 * linked its row to ours, and reads that include the relation showed its
 * name or rate.
 */
const mocks = vi.hoisted(() => ({
  workspace: vi.fn(),
  rateCardCreate: vi.fn(),
  rateCardUpdate: vi.fn(),
  rateCardFind: vi.fn(),
  category: vi.fn(),
  taxRate: vi.fn(),
}));

vi.mock('@wolff/database', () => ({
  prisma: {
    rateCard: {
      create: mocks.rateCardCreate,
      update: mocks.rateCardUpdate,
      findFirst: mocks.rateCardFind,
    },
    rateCardCategory: { findFirst: mocks.category },
    taxRate: { findFirst: mocks.taxRate },
    project: { findFirst: vi.fn().mockResolvedValue(null) },
  },
  Prisma: {},
}));
vi.mock('@/lib/workspace/get-current-workspace', () => ({
  getCurrentUserWorkspace: mocks.workspace,
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { createRateCard, updateRateCard } from '@/lib/rate-cards/actions';

describe('references to other records stay in the workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workspace.mockResolvedValue({ workspaceId: 'ws-1', userId: 'u-1', role: 'owner' });
    mocks.rateCardFind.mockResolvedValue({ id: 'rc-1', workspaceId: 'ws-1' });
    mocks.rateCardCreate.mockResolvedValue({ id: 'rc-2' });
    // Neither id exists in ws-1.
    mocks.category.mockResolvedValue(null);
    mocks.taxRate.mockResolvedValue(null);
  });

  it("refuses a rate card with another workspace's category or tax rate", async () => {
    await expect(
      createRateCard({ name: 'X', rate: 1, categoryId: 'cat-other' } as never)
    ).rejects.toThrow(/category/i);
    await expect(updateRateCard({ id: 'rc-1', taxRateId: 'tax-other' } as never)).rejects.toThrow(
      /tax rate/i
    );
    expect(mocks.rateCardCreate).not.toHaveBeenCalled();
    expect(mocks.rateCardUpdate).not.toHaveBeenCalled();
    expect(mocks.category).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'cat-other', workspaceId: 'ws-1' }),
      })
    );
  });

  it('accepts ids from the same workspace', async () => {
    mocks.category.mockResolvedValue({ id: 'cat-1' });
    await expect(
      createRateCard({ name: 'X', rate: 1, categoryId: 'cat-1' } as never)
    ).resolves.toEqual({
      id: 'rc-2',
    });
  });

  it("refuses a quote linked to another workspace's project", async () => {
    const { assertReferencesInWorkspace } = await import('@/lib/workspace/references');
    await expect(assertReferencesInWorkspace('ws-1', { projectId: 'proj-other' })).rejects.toThrow(
      /project/i
    );
  });
});
