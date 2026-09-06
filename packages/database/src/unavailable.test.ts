import { describe, expect, it } from 'vitest';
import { isDatabaseUnavailable } from './unavailable';

describe('isDatabaseUnavailable', () => {
  it.each([
    [
      'Neon over quota (as Sentry saw it)',
      Object.assign(
        new Error(
          'Database error. Code: `53000`. Message: `Your account or project has exceeded the quota.`'
        ),
        { code: 'P2039' }
      ),
    ],
    ['cannot reach the server', Object.assign(new Error('x'), { code: 'P1001' })],
    [
      'client init failed',
      Object.assign(new Error('x'), { name: 'PrismaClientInitializationError' }),
    ],
    ['pg connection exception', Object.assign(new Error('x'), { code: '08006' })],
    ['pg shutting down', Object.assign(new Error('x'), { code: '57P01' })],
    ['dropped connection', new Error('Connection terminated due to connection timeout')],
    [
      'dead pool client',
      new Error('Client has encountered a connection error and is not queryable'),
    ],
    [
      'wrapped in a cause',
      new Error('job failed', { cause: new Error('Connection terminated unexpectedly') }),
    ],
  ])('recognises %s', (_label, error) => {
    expect(isDatabaseUnavailable(error)).toBe(true);
  });

  it.each([
    ['a unique violation', Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })],
    ['a pg syntax error', Object.assign(new Error('x'), { code: '42601' })],
    ['a provider error', new Error('Resend answered 503')],
    // Webhook and email deliveries fail with the same socket errors: a
    // customer's endpoint being down is not a database outage.
    [
      'a refused webhook endpoint',
      Object.assign(new Error('connect ECONNREFUSED 203.0.113.9:443'), { code: 'ECONNREFUSED' }),
    ],
    [
      'a timed-out request',
      Object.assign(new Error('connect ETIMEDOUT 203.0.113.9:443'), { code: 'ETIMEDOUT' }),
    ],
    [
      'an unknown host',
      Object.assign(new Error('getaddrinfo ENOTFOUND hooks.example.com'), { code: 'ENOTFOUND' }),
    ],
    ['a fetch timeout', new Error('Webhook request timed out after 10000 ms: connection timeout')],
    ['not an error', 'oops'],
    ['nothing', undefined],
  ])('does not mistake %s for an outage', (_label, error) => {
    expect(isDatabaseUnavailable(error)).toBe(false);
  });
});
