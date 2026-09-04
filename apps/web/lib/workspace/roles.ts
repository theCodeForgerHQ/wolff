/**
 * Workspace roles, lowest to highest. These are the values stored in
 * `WorkspaceMember.role` (default `member`) and the ones `updateMemberRole`
 * accepts.
 */
export const WORKSPACE_ROLES = ['viewer', 'member', 'admin', 'owner'] as const;

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/**
 * Whether `role` is at least `min`. A role outside WORKSPACE_ROLES (a stale
 * or mistyped value from the database) is denied rather than ranked.
 */
export function hasRole(role: WorkspaceRole, min: WorkspaceRole): boolean {
  const rank = WORKSPACE_ROLES.indexOf(role);
  return rank !== -1 && rank >= WORKSPACE_ROLES.indexOf(min);
}
