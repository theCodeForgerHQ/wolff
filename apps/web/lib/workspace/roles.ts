/**
 * Workspace roles, lowest to highest. These are the values stored in
 * `WorkspaceMember.role` (default `member`) and the ones `updateMemberRole`
 * accepts.
 */
export const WORKSPACE_ROLES = ['viewer', 'member', 'admin', 'owner'] as const;

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/**
 * Whether `role` is at least `min`. A value outside WORKSPACE_ROLES, on
 * either side (a stale or mistyped role from the database, a wrong
 * minimum), is denied rather than ranked.
 */
export function hasRole(role: WorkspaceRole, min: WorkspaceRole): boolean {
  const rank = WORKSPACE_ROLES.indexOf(role);
  const needed = WORKSPACE_ROLES.indexOf(min);
  return rank !== -1 && needed !== -1 && rank >= needed;
}
