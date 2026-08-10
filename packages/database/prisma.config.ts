import path from 'node:path';
import { defineConfig } from 'prisma/config';
import { loadEnvFiles } from './scripts/load-env';

// Prisma 7 no longer loads .env files or reads the URL from schema.prisma.
// Load root env files so `pnpm db:*` scripts from the monorepo root work. An
// exported DATABASE_URL wins over both files (scratch databases, CI).
loadEnvFiles(path.resolve(import.meta.dirname ?? '.', '../..'));

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // Not env('DATABASE_URL'): that throws when the variable is unset, and
    // `prisma generate` (CI type-check, Docker build) needs no database.
    url: process.env.DATABASE_URL ?? '',
    // Only needed by `prisma migrate diff --from-migrations` and `migrate dev`.
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
