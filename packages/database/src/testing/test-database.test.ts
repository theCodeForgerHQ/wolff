import { describe, expect, it } from 'vitest';
import { createPrisma } from '../client';
import { packageDatabaseUrl } from './test-database';

describe('packageDatabaseUrl', () => {
  const base = 'postgresql://wolff:pw@localhost:5432/wolff?schema=public';

  it('gives each package its own database next to the base, keeping the options', () => {
    expect(packageDatabaseUrl(base, '@wolff/jobs')).toEqual({
      name: 'wolff_t_jobs',
      url: 'postgresql://wolff:pw@localhost:5432/wolff_t_jobs?schema=public',
      template: 'wolff',
      adminUrl: 'postgresql://wolff:pw@localhost:5432/postgres?schema=public',
    });
    expect(packageDatabaseUrl(base, '@wolff/web').name).toBe('wolff_t_web');
  });

  it('refuses names that are not plain identifiers', () => {
    expect(() => packageDatabaseUrl('postgresql://h/a-b', '@wolff/jobs')).toThrow(/a-b/);
    expect(() => packageDatabaseUrl(base, 'Bad Name')).toThrow(/Bad Name/);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('this package under test (Postgres)', () => {
  it('runs against its own migrated copy of the test database', async () => {
    const db = createPrisma(process.env.TEST_DATABASE_URL);
    try {
      const [row] = await db.$queryRawUnsafe<[{ name: string; migrations: number }]>(
        `SELECT current_database() AS name,
                (SELECT count(*)::int FROM public._prisma_migrations) AS migrations`
      );
      expect(row.name).toMatch(/_t_database$/);
      expect(row.migrations).toBeGreaterThan(0);
    } finally {
      await db.$disconnect();
    }
  });
});
