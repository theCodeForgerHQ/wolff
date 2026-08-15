// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ workspaceId: 'ws-1', userId: 'user-1', role: 'owner' }));
const core = vi.hoisted(() => ({
  createAutomation: vi.fn().mockResolvedValue({ id: 'a1' }),
  updateAutomation: vi.fn().mockResolvedValue({ id: 'a1' }),
  deleteAutomation: vi.fn().mockResolvedValue({ id: 'a1' }),
  listAutomations: vi.fn(),
  listAutomationRuns: vi.fn(),
  approveRun: vi.fn(),
}));
vi.mock('@wolff/database', () => ({ prisma: {}, withTenantGuard: (c: unknown) => c }));
vi.mock('@wolff/core/automations', () => core);
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/workspace/get-current-workspace', () => ({
  getCurrentUserWorkspace: vi.fn(async () => session),
}));

import { createAutomation, deleteAutomation, updateAutomation } from '@/lib/automations/actions';

const input = {
  name: 'Overdue nudge',
  trigger: 'invoice.overdue' as const,
  steps: [{ type: 'wait' as const, days: 7 }],
  isActive: true,
};

describe('automation server actions', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['member', 'viewer'])(
    'refuse a %s: only owners and admins change automations',
    async (role) => {
      session.role = role;

      const results = await Promise.all([
        createAutomation(input),
        updateAutomation('a1', { isActive: false }),
        deleteAutomation('a1'),
      ]);

      for (const result of results) {
        expect(result).toEqual({ success: false, error: expect.stringMatching(/owner or admin/) });
      }
      expect(core.createAutomation).not.toHaveBeenCalled();
      expect(core.updateAutomation).not.toHaveBeenCalled();
      expect(core.deleteAutomation).not.toHaveBeenCalled();
    }
  );

  it.each(['owner', 'admin'])('let an %s change automations', async (role) => {
    session.role = role;

    expect(await createAutomation(input)).toEqual({ success: true });
    expect(await deleteAutomation('a1')).toEqual({ success: true });
  });
});
