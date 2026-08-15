import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createPrisma } from './client';

const url = process.env.TEST_DATABASE_URL;
const MIGRATION = join(
  __dirname,
  '../prisma/migrations/20260809130000_lead_contact_normalisation/migration.sql'
);

/**
 * Runs the migration against a copy of the leads table in its own schema,
 * seeded with the data that broke it: leads that differ only by email case.
 */
describe.skipIf(!url)('migration 20260809130000_lead_contact_normalisation (Postgres)', () => {
  const db = createPrisma(url);
  const schema = `mig_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

  afterAll(async () => {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
  });

  it('lower-cases one lead per email and flags the others, deterministically', async () => {
    const statements = readFileSync(MIGRATION, 'utf8')
      .split(/;\s*\n/)
      .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
      .filter(Boolean);
    const ws = randomUUID();
    const rows = [
      ['a1', 'Asha@Example.com', '2026-01-02'],
      ['a2', 'asha@EXAMPLE.com', '2026-01-01'],
      ['b1', 'Ravi@x.in', '2026-01-01'],
      ['b2', 'ravi@x.in', '2026-01-05'],
      ['c1', 'Solo@X.in', '2026-01-01'],
    ];

    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      await tx.$executeRawUnsafe(`CREATE TABLE leads (LIKE public.leads INCLUDING DEFAULTS)`);
      await tx.$executeRawUnsafe(
        `CREATE UNIQUE INDEX leads_workspace_id_email_key ON leads (workspace_id, email)`
      );
      for (const [id, email, created] of rows) {
        await tx.$executeRawUnsafe(
          `INSERT INTO leads (id, workspace_id, name, email, phone, created_at, updated_at)
           VALUES ($1, $2, 'Lead', $3, ' +91 98400-12345 ', $4::timestamp, now())`,
          id,
          ws,
          email,
          created
        );
      }
      for (const statement of statements) await tx.$executeRawUnsafe(statement);
    });

    const after = await db.$queryRawUnsafe<
      { id: string; email: string; message: string | null; phone: string }[]
    >(`SELECT id, email, message, phone FROM "${schema}".leads ORDER BY id`);
    const byId = Object.fromEntries(after.map((r) => [r.id, r]));
    // Oldest of a group wins, unless one is already lower-case.
    expect(byId.a2!.email).toBe('asha@example.com');
    expect(byId.a1!.email).toBe('Asha@Example.com');
    expect(byId.a1!.message).toMatch(/Possible duplicate of lead a2/);
    expect(byId.b2!.email).toBe('ravi@x.in');
    expect(byId.b1!.message).toMatch(/Possible duplicate of lead b2/);
    expect(byId.c1).toMatchObject({ email: 'solo@x.in', message: null });
    expect(byId.c1!.phone).toBe('+919840012345');
  });
});
