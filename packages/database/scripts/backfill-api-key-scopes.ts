import { pathToFileURL } from 'node:url';
import { LEGACY_KEY_SCOPES } from '@wolff/contracts';
import { createPrisma, type PrismaClient } from '../src/client';

/**
 * Gives secret API keys that have no scopes the set they could use before
 * scopes existed. The migration that added the column does this once; this
 * script covers keys the previous release created while it was still running
 * during a deploy. Safe to run any number of times.
 *
 * Usage: DATABASE_URL=… pnpm --filter @wolff/database backfill:api-key-scopes
 */
export async function backfillApiKeyScopes(db: PrismaClient): Promise<number> {
  const result = await db.apiKey.updateMany({
    where: { kind: 'secret', scopes: { isEmpty: true } },
    data: { scopes: [...LEGACY_KEY_SCOPES] },
  });
  return result.count;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = createPrisma();
  backfillApiKeyScopes(db)
    .then((count) => process.stdout.write(`api_keys backfilled: ${count}\n`))
    .finally(() => db.$disconnect());
}
