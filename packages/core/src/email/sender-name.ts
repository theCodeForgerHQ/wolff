/**
 * The name an email to a client goes out under: the business name from the
 * business profile, else the workspace's own name. Subject and body use the
 * same one, so a client never sees "Acme Design Studio" above "Demo Workspace".
 */
export function senderName(workspace: {
  name: string;
  businessProfile?: { businessName: string | null } | null;
}): string {
  return workspace.businessProfile?.businessName?.trim() || workspace.name;
}
