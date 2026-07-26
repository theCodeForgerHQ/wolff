import type { TenantGuardedClient } from '@wolff/database';

/** The guarded client, or the transaction client it hands to `$transaction`. */
export type Db = TenantGuardedClient;
export type DbTx = Parameters<Parameters<Db['$transaction']>[0]>[0];
export type DbOrTx = Db | DbTx;

/**
 * What every core function receives. `workspaceId` always comes from the
 * caller's credential (session, API key, service JWT), never from a request
 * body.
 */
export interface CoreContext {
  db: Db;
  workspaceId: string;
  actorId?: string;
}
