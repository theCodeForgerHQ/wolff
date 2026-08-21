import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockGetCurrentUserWorkspace } = vi.hoisted(() => {
  const mockPrisma: Record<string, any> = {
    contractInstance: { findFirst: vi.fn(), update: vi.fn() },
    outboxEvent: { create: vi.fn().mockResolvedValue({ id: 'evt-1' }) },
    $transaction: vi.fn((fn: any) => fn(mockPrisma)),
  };
  return { mockPrisma, mockGetCurrentUserWorkspace: vi.fn() };
});

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/workspace/get-current-workspace', () => ({
  getCurrentUserWorkspace: mockGetCurrentUserWorkspace,
}));
vi.mock('@/lib/services/email', () => ({ sendEmail: vi.fn() }));
vi.mock('@/lib/email/actions', () => ({ sendTemplatedEmail: vi.fn() }));
vi.mock('@/lib/notifications/internal', () => ({
  createNotification: vi.fn(),
  notifyWorkspaceMembers: vi.fn(),
}));
vi.mock('@wolff/database', () => ({ prisma: mockPrisma, Prisma: {} }));

import { deleteContractInstance } from '@/lib/contracts/actions';

describe('deleteContractInstance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUserWorkspace.mockResolvedValue({ workspaceId: 'ws-1', role: 'owner' });
  });

  it('soft-deletes and asks the AI service to drop the contract from its index', async () => {
    mockPrisma.contractInstance.findFirst.mockResolvedValue({ id: 'ci-1', status: 'draft' });

    await deleteContractInstance('ci-1');

    expect(mockPrisma.contractInstance.update).toHaveBeenCalledWith({
      where: { id: 'ci-1', workspaceId: 'ws-1' },
      data: { deletedAt: expect.any(Date) },
    });
    expect(mockPrisma.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: 'ws-1',
        type: 'ai.index',
        payload: { sourceType: 'contract', sourceId: 'ci-1' },
      }),
      select: { id: true },
    });
  });

  it('leaves a signed contract and the index alone', async () => {
    mockPrisma.contractInstance.findFirst.mockResolvedValue({ id: 'ci-1', status: 'signed' });

    await expect(deleteContractInstance('ci-1')).rejects.toThrow('signed');
    expect(mockPrisma.outboxEvent.create).not.toHaveBeenCalled();
  });
});
