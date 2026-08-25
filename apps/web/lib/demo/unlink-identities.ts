import type { PrismaClient } from '@wolff/database';
import { DEMO_CONFIG } from './constants';

/**
 * Delete every OAuth identity linked to the demo user. Before 3aeba03 a
 * Google sign-in from a browser holding the demo session linked that
 * Google account to the shared demo user, giving its owner a standing
 * login to it. Wolff has no "connect another login" feature, so the demo
 * user should have none. Matches the user by exact email; returns the
 * number of identities removed.
 */
export async function unlinkDemoIdentities(
  db: Pick<PrismaClient, 'account'>,
  email: string = DEMO_CONFIG.email
): Promise<number> {
  const { count } = await db.account.deleteMany({ where: { user: { email } } });
  return count;
}
