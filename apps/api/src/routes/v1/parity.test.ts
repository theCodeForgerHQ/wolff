import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EmailMessage } from '@wolff/jobs';
import { TEST_DATABASE_URL, testApp, testDb } from '../../testing/harness';
import { runParityScenario, type ParityResponse } from '../../testing/parity/runner';
import type { RouteGroup } from '../../testing/parity/scenario';
import { clearParityData, seedParityData } from '../../testing/parity/seed';

/**
 * Phase 6b's DoD: the routes ported from Next answer exactly as the Next
 * routes did. `__parity__/next-api-v1.json` holds the Next `/api/v1`
 * responses to a fixed scenario on a seeded database (recorded with
 * `scripts/record-parity.ts`); here the same scenario runs against the
 * Express app on the same seed and every response is compared: status and
 * the normalized body, byte for byte (envelope, field order, pagination,
 * error messages). 401s are compared on status and the presence of `error`
 * only, since the API answers them with the standard envelope.
 */
const PORTED: RouteGroup[] = ['clients', 'quotes', 'invoices'];

const recorded = JSON.parse(
  readFileSync(resolve(__dirname, '__parity__/next-api-v1.json'), 'utf8')
) as ParityResponse[];

describe.skipIf(!TEST_DATABASE_URL)('/v1 parity with the Next /api/v1 routes (Postgres)', () => {
  const { base, db } = testDb();
  const sent: EmailMessage[] = [];
  let server: Server;
  let replayed: ParityResponse[] = [];

  beforeAll(async () => {
    await seedParityData(base);
    const app = testApp(db, {
      email: { send: async (message) => void sent.push(message) },
    });
    server = createServer(app);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    replayed = await runParityScenario(`http://127.0.0.1:${port}`, '/v1');
  }, 120_000);

  afterAll(async () => {
    await new Promise((done) => server?.close(done));
    await clearParityData(base);
    await base.$disconnect();
  });

  it('replays every recorded request', () => {
    expect(replayed.map((r) => r.name)).toEqual(recorded.map((r) => r.name));
  });

  const cases = recorded
    .map((expected, index) => ({ expected, index }))
    .filter(({ expected }) => PORTED.includes(expected.group));

  it.each(cases)('$expected.method $expected.name', ({ expected, index }) => {
    const actual = replayed[index]!;
    expect(actual.path).toBe(expected.path);
    expect(actual.status).toBe(expected.status);
    if (expected.authFailure) {
      const error = (JSON.parse(actual.body) as { error?: unknown }).error;
      const message = typeof error === 'string' ? error : (error as { message?: unknown })?.message;
      expect(typeof message).toBe('string');
      return;
    }
    expect(actual.body).toBe(expected.body);
  });

  it.skipIf(!PORTED.includes('invoices'))(
    'sent the quote and invoice emails to the right people',
    () => {
      expect(sent.map((m) => m.to).sort()).toEqual(
        [
          'a@parity.test',
          'acme@parity.test',
          'acme@parity.test',
          'acme@parity.test',
          'acme@parity.test',
          'b@parity.test',
        ].sort()
      );
      expect(sent.find((m) => m.subject.startsWith('Invoice'))?.subject).toBe(
        'Invoice INV-0001 from Parity Studio - ₹1,120.00'
      );
    }
  );
});
