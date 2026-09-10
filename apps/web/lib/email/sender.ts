import { prisma } from '@wolff/database';
import { senderName } from '@wolff/core/email';

/** The business name and email a client-facing email goes out under. */
export async function senderDetails(workspace: { id: string; name: string }) {
  const businessProfile = await prisma.businessProfile.findUnique({
    where: { workspaceId: workspace.id },
    select: { email: true, businessName: true },
  });
  return {
    businessName: senderName({ name: workspace.name, businessProfile }),
    businessEmail: businessProfile?.email || '',
  };
}
