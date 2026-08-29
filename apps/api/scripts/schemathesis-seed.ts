import { API_SCOPES } from '@wolff/contracts';
import { hashApiKey } from '@wolff/core/auth/api-keys';
import { createPrisma } from '@wolff/database';
import { PARITY, seedParityData } from '../src/testing/parity/seed';

/**
 * Seeds the database Schemathesis runs against (`.github/workflows/ci.yml`
 * job `schemathesis`; locally, see docs/phase-6b.md): the parity suite's
 * fixed workspace, plus a key with every scope so the webhook-endpoint
 * routes are reachable too. The key is a fixed test value, not a secret.
 */
export const SCHEMATHESIS_KEY = 'qc_sk_schemathesis00000000000000000000001';

async function main() {
  const db = createPrisma(process.env.DATABASE_URL);
  try {
    await seedParityData(db);
    await db.apiKey.create({
      data: {
        workspaceId: PARITY.workspace,
        name: 'schemathesis',
        keyHash: hashApiKey(SCHEMATHESIS_KEY),
        keyPrefix: SCHEMATHESIS_KEY.slice(0, 10),
        scopes: [...API_SCOPES],
        rateLimitPerMin: 100_000,
      },
    });
    console.log('Seeded the Schemathesis workspace');
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
