/* global process */
// Dependency-free Prisma config for one-off `prisma migrate deploy` runs in a
// bare container (docs/DOCKER.md), where prisma.config.ts can't load dotenv or
// prisma/config. DATABASE_URL must be set in the environment.
export default {
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL },
};
