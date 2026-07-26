import { pathToFileURL } from 'node:url';
import { createPrisma, type PrismaClient } from '../src/client';

/**
 * Fills payments.workspace_id from the invoice and
 * webhook_deliveries.workspace_id from the endpoint, for rows that lack it.
 * The migration that added the columns does this once; this covers rows the
 * previous release wrote during a deploy. Only touches NULLs, so it is safe to
 * run any number of times.
 *
 * Usage: DATABASE_URL=… pnpm --filter @wolff/database backfill:workspace-ids
 */
export async function backfillWorkspaceIds(
  db: PrismaClient
): Promise<{ payments: number; webhookDeliveries: number }> {
  const payments = await db.$executeRaw`
    UPDATE payments p SET workspace_id = i.workspace_id
    FROM invoices i
    WHERE i.id = p.invoice_id AND p.workspace_id IS NULL`;
  const webhookDeliveries = await db.$executeRaw`
    UPDATE webhook_deliveries d SET workspace_id = e.workspace_id
    FROM webhook_endpoints e
    WHERE e.id = d.endpoint_id AND d.workspace_id IS NULL`;
  return { payments, webhookDeliveries };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = createPrisma();
  backfillWorkspaceIds(db)
    .then((counts) => process.stdout.write(`${JSON.stringify(counts)}\n`))
    .finally(() => db.$disconnect());
}
