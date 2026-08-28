import { CoreError } from '../errors';
import type { DbOrTx } from '../context';

/**
 * An owner (`ownerId`) must be a member of the workspace. Checked before the
 * write: an unknown user id used to reach the foreign key and end in a 500,
 * and a user of another workspace would have been accepted.
 */
export async function assertWorkspaceMember(
  db: DbOrTx,
  workspaceId: string,
  userId: string | null | undefined
): Promise<void> {
  if (!userId) return;
  const member = await db.workspaceMember.findFirst({
    where: { workspaceId, userId },
    select: { userId: true },
  });
  if (!member)
    throw new CoreError('validation_error', 'The owner is not a member of this workspace');
}
