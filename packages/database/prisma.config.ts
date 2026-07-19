import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Prisma 7 no longer loads .env files or reads the URL from schema.prisma.
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
