import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createPrisma } from './client';

const url = process.env.TEST_DATABASE_URL;
const MIGRATION = join(
  __dirname,
  '../prisma/migrations/20260915120000_receivables_include_viewed/migration.sql'
);

/** The ageing view, built in its own schema over a copy of the invoices table. */
describe.skipIf(!url)('v_receivables_ageing (Postgres)', () => {
  const db = createPrisma(url);
  const schema = `view_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

  afterAll(async () => {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
  });

  it('counts every unpaid invoice that has been sent, including viewed ones', async () => {
    const ws = randomUUID();
    const statuses = ['draft', 'sent', 'viewed', 'partial', 'overdue', 'paid'];
    const rows = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}", public`);
      await tx.$executeRawUnsafe(`CREATE TABLE invoices (LIKE public.invoices INCLUDING DEFAULTS)`);
      for (const status of statuses) {
        await tx.$executeRawUnsafe(
          `INSERT INTO invoices (id, workspace_id, client_id, invoice_number, status, due_date,
             access_token, updated_at, total, amount_due)
           VALUES ($1, $2, 'client', $3, $3, CURRENT_DATE, $5, now(), 100, $4)`,
          randomUUID(),
          ws,
          status,
          status === 'paid' ? 0 : 100,
          randomUUID()
        );
      }
      await tx.$executeRawUnsafe(readFileSync(MIGRATION, 'utf8'));
      return tx.$queryRawUnsafe<{ invoice_number: string }[]>(
        `SELECT invoice_number FROM "${schema}".v_receivables_ageing ORDER BY invoice_number`
      );
    });

    expect(rows.map((r) => r.invoice_number)).toEqual(['overdue', 'partial', 'sent', 'viewed']);
  });
});
