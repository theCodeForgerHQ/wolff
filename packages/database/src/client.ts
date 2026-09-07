import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';

/**
 * Pool settings for the pg driver adapter (Prisma 7 hands pooling to `pg`).
 * Tuned for serverless on Neon: many instances, each frozen between
 * requests, sharing a small database that suspends 5 minutes after the last
 * query and closes its sockets.
 * - few connections per instance;
 * - idle and old connections are closed well before Neon would close them,
 *   so a thawed instance does not reuse a dead socket;
 * - a connect timeout long enough for a suspended database to wake.
 */
export const POOL = {
  max: Number(process.env.DATABASE_POOL_MAX ?? 5),
  connectionTimeoutMillis: 15_000,
  idleTimeoutMillis: 10_000,
  maxLifetimeSeconds: 240,
  keepAlive: true,
};

/**
 * An idle client that loses its connection makes the pool emit 'error'; with
 * no listener that is an uncaught exception. The pool drops the client and
 * the next query gets a fresh connection, so logging is enough.
 */
function onPoolError(error: Error) {
  console.warn(`[database] idle connection lost: ${error.message}`);
}

/**
 * Builds a client over the pg driver adapter. The adapter connects lazily, so
 * importing this module (for types, enums or at build time) opens no socket.
 */
export function createPrisma(connectionString = process.env.DATABASE_URL) {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString, ...POOL }, { onPoolError }),
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
    // Bug #115: Configure transaction and query timeouts to prevent long-running queries
    transactionOptions: {
      maxWait: 10000, // 10s max wait to acquire a connection
      timeout: 30000, // 30s max transaction duration
    },
  });
}

const globalForPrisma = globalThis as unknown as {
  prisma: ReturnType<typeof createPrisma> | undefined;
};

export const prisma = globalForPrisma.prisma ?? createPrisma();

// Cache Prisma client on globalThis to prevent multiple instances
// In dev: prevents HMR from creating new clients
// In production/serverless: ensures connection reuse within warm instances
globalForPrisma.prisma = prisma;

export type { PrismaClient };
