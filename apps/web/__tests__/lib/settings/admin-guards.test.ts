import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockGetCurrentUserWorkspace } = vi.hoisted(() => {
  const write = () => vi.fn().mockResolvedValue({});
  const mockPrisma: Record<string, any> = {
    workspace: { update: write(), findUnique: vi.fn().mockResolvedValue({ settings: {} }) },
    businessProfile: { upsert: write(), update: write(), findUnique: vi.fn() },
    brandingSettings: { upsert: write() },
    emailSettings: { upsert: write() },
    paymentSettings: { upsert: write(), findUnique: vi.fn() },
    $transaction: vi.fn((fn: any) => fn(mockPrisma)),
  };
  return { mockPrisma, mockGetCurrentUserWorkspace: vi.fn() };
});

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/workspace/get-current-workspace', () => ({
  getCurrentUserWorkspace: mockGetCurrentUserWorkspace,
}));
vi.mock('@wolff/database', () => ({ prisma: mockPrisma, Prisma: { JsonNull: null } }));

import {
  updateWorkspaceName,
  updateBusinessProfile,
  updateBusinessLogo,
  updateEmailSettings,
  updateBrandingSettings,
  updatePaymentSettings,
} from '@/lib/settings/actions';

const ADMIN_ONLY: [string, () => Promise<unknown>][] = [
  ['updateWorkspaceName', () => updateWorkspaceName('Renamed')],
  ['updateBusinessProfile', () => updateBusinessProfile({ businessName: 'X' } as never)],
  ['updateBusinessLogo', () => updateBusinessLogo(null)],
  ['updateEmailSettings', () => updateEmailSettings({} as never)],
  ['updateBrandingSettings', () => updateBrandingSettings({} as never)],
  ['updatePaymentSettings', () => updatePaymentSettings({} as never)],
];

function asRole(role: string) {
  mockGetCurrentUserWorkspace.mockResolvedValue({ workspaceId: 'ws-1', userId: 'u-1', role });
}

function writes() {
  return [
    mockPrisma.workspace.update,
    mockPrisma.businessProfile.upsert,
    mockPrisma.businessProfile.update,
    mockPrisma.brandingSettings.upsert,
    mockPrisma.emailSettings.upsert,
    mockPrisma.paymentSettings.upsert,
  ].reduce((n, fn) => n + fn.mock.calls.length, 0);
}

describe('admin-only settings actions', () => {
  beforeEach(() => vi.clearAllMocks());

  // `member` is the default role of every invited user (schema.prisma).
  describe.each(['member', 'viewer'])('as %s', (role) => {
    it.each(ADMIN_ONLY)('%s is refused before any write', async (_name, call) => {
      asRole(role);
      await expect(call()).rejects.toThrow(/admin/i);
      expect(writes()).toBe(0);
    });
  });

  it.each(['admin', 'owner'])('lets %s rename the workspace', async (role) => {
    asRole(role);
    await updateWorkspaceName('Renamed');
    expect(mockPrisma.workspace.update).toHaveBeenCalledWith({
      where: { id: 'ws-1' },
      data: { name: 'Renamed' },
    });
  });
});
