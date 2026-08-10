import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEnvFiles } from './load-env';

describe('loadEnvFiles (prisma.config.ts)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wolff-env-'));
  writeFileSync(join(dir, '.env'), 'DATABASE_URL=from-dotenv\nONLY_IN_ENV=env\n');
  writeFileSync(join(dir, '.env.local'), 'DATABASE_URL=from-dotenv-local\n');

  it('never overrides a variable exported in the shell', () => {
    const env: Record<string, string | undefined> = { DATABASE_URL: 'exported' };

    loadEnvFiles(dir, env);

    // A scratch-database run (DATABASE_URL=... pnpm db:migrate) must not be
    // redirected to the developer's database by .env.local.
    expect(env.DATABASE_URL).toBe('exported');
    expect(env.ONLY_IN_ENV).toBe('env');
  });

  it('prefers .env.local over .env when nothing is exported', () => {
    const env: Record<string, string | undefined> = {};

    loadEnvFiles(dir, env);

    expect(env.DATABASE_URL).toBe('from-dotenv-local');
  });
});
