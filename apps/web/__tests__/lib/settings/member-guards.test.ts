// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  workspace: vi.fn(),
  current: vi.fn(),
  target: vi.fn(),
  count: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  remove: vi.fn(),
  invite: vi.fn(),
}));

vi.mock('@wolff/database', () => ({
  prisma: {
    workspaceMember: {
      findUnique: mocks.current,
      findFirst: mocks.target,
      count: mocks.count,
      update: mocks.update,
      updateMany: mocks.updateMany,
      delete: mocks.remove,
    },
    workspace: { update: vi.fn(), findUnique: vi.fn().mockResolvedValue({ name: 'W' }) },
    user: { findUnique: vi.fn().mockResolvedValue(null) },
    workspaceInvitation: { findFirst: vi.fn().mockResolvedValue(null), create: mocks.invite },
  },
  Prisma: { JsonNull: null },
}));
vi.mock('@/lib/workspace/get-current-workspace', () => ({
  getCurrentUserWorkspace: mocks.workspace,
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { inviteMember, removeMember, updateMemberRole } from '@/lib/settings/actions';

function as(actorRole: string, targetRole: string) {
  mocks.workspace.mockResolvedValue({ workspaceId: 'ws-1', userId: 'actor', role: actorRole });
  mocks.current.mockResolvedValue({ id: 'm-actor', userId: 'actor', role: actorRole });
  mocks.target.mockResolvedValue({ id: 'm-target', userId: 'target', role: targetRole });
  // Two owners: the "last owner" rule does not apply, only rank does.
  mocks.count.mockResolvedValue(2);
}

describe('workspace members: rank', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not let an admin demote an owner', async () => {
    as('admin', 'owner');
    expect(await updateMemberRole('m-target', 'viewer')).toMatchObject({ success: false });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it('does not let an admin remove an owner', async () => {
    as('admin', 'owner');
    expect(await removeMember('m-target')).toMatchObject({ success: false });
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('still lets an admin change a member, and an owner change an owner', async () => {
    as('admin', 'member');
    mocks.update.mockResolvedValue({});
    expect(await updateMemberRole('m-target', 'viewer')).toMatchObject({ success: true });
    as('owner', 'owner');
    expect(await updateMemberRole('m-target', 'admin')).toMatchObject({ success: true });
  });

  // Ownership moves through updateMemberRole, which keeps one owner; an
  // invitation would add a second.
  it('does not invite anyone as an owner', async () => {
    as('owner', 'member');
    expect(await inviteMember('new@example.com', 'owner')).toMatchObject({ success: false });
    expect(mocks.invite).not.toHaveBeenCalled();
  });
});
