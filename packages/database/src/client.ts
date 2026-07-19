import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';

/**
 * Pool settings for the pg driver adapter. Prisma 7 hands pooling to `pg`,
 * whose defaults differ from Prisma 6 (no connect timeout, 10 connections),
 * so they are set explicitly to Prisma 6's values.
 */
const POOL = {
  max: Number(process.env.DATABASE_POOL_MAX ?? 10),
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 300_000,
};

/**
 * Builds a client over the pg driver adapter. The adapter connects lazily, so
 * importing this module (for types, enums or at build time) opens no socket.
 */
export function createPrisma(connectionString = process.env.DATABASE_URL) {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString, ...POOL }),
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
