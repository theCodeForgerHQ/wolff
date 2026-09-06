/**
 * Prisma codes for "the database is not there": cannot reach it, timed out,
 * closed the connection, or the server is out of resources.
 */
const PRISMA_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017']);

/**
 * Postgres SQLSTATE classes for the same: 08 connection exception, 53
 * insufficient resources (Neon's "exceeded the quota" is 53000), 57P0x
 * shutting down. Prisma wraps them in P2039-style errors whose message
 * carries "Code: `53000`".
 */
const SQLSTATE = /^(08|53)\d{3}$|^57P0[1-3]$/;
const SQLSTATE_IN_MESSAGE = /Code: `(08\d{3}|53\d{3}|57P0[1-3])`/;

/**
 * Messages only the pg driver and Prisma produce for a lost or unusable
 * database connection. Generic socket errors (ECONNREFUSED, ETIMEDOUT, ...)
 * are left out on purpose: webhook and email deliveries fail with the same
 * ones, and a customer's endpoint being down is not a database outage.
 */
const DRIVER_MESSAGES = /^Connection terminated|is not queryable|Can't reach database server/;

/**
 * Whether `error` (or its cause) says the database is unavailable, rather
 * than that this query or this data is wrong. A caller can then wait and try
 * later instead of treating it as a bug in the job.
 */
export function isDatabaseUnavailable(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 5) return false;
  const { name, code, message, cause } = error as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  if (name === 'PrismaClientInitializationError') return true;
  if (typeof code === 'string' && (PRISMA_CODES.has(code) || SQLSTATE.test(code))) return true;
  if (typeof message === 'string') {
    if (SQLSTATE_IN_MESSAGE.test(message) || DRIVER_MESSAGES.test(message)) return true;
  }
  return isDatabaseUnavailable(cause, depth + 1);
}
