import { describe, expect, it } from 'vitest';
import { POOL } from './client';

/** Neon suspends compute 5 minutes after the last query and drops its sockets. */
const NEON_SUSPEND_MS = 5 * 60_000;

describe('pg pool settings', () => {
  it('drops idle and old connections before Neon suspends and closes them', () => {
    // A frozen serverless instance that thaws later must not reuse a socket
    // the server already closed ("Client has encountered a connection error
    // and is not queryable", seen in Sentry 2026-10-16).
    expect(POOL.idleTimeoutMillis).toBeLessThan(NEON_SUSPEND_MS);
    expect(POOL.maxLifetimeSeconds * 1000).toBeLessThan(NEON_SUSPEND_MS);
    expect(POOL.keepAlive).toBe(true);
  });

  it('waits long enough to connect for a suspended database to wake', () => {
    // 5 s was shorter than a Neon cold start ("Connection terminated due to
    // connection timeout", Sentry 2026-10-18).
    expect(POOL.connectionTimeoutMillis).toBeGreaterThanOrEqual(10_000);
  });

  it('keeps few connections per instance: many serverless instances share a small database', () => {
    expect(POOL.max).toBeLessThanOrEqual(5);
  });
});
