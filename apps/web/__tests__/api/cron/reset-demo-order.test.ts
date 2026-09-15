// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Records every prisma call so the test can check the delete order. The
// workspace lookup finds the demo workspace; everything else returns empty.
const calls: string[] = [];
const args: Record<string, unknown[]> = {};
vi.mock('@wolff/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wolff/database')>();
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_, method: string) => async (arg?: unknown) => {
          calls.push(`${name}.${method}`);
          (args[`${name}.${method}`] ??= []).push(arg);
          if (name === 'workspace' && method.startsWith('find')) return { id: 'ws-demo' };
          if (method.startsWith('find') && method.endsWith('Many')) return [];
          if (method.endsWith('Many')) return { count: 0 };
          if (method === 'create' || method === 'upsert')
            return { id: `${name}-${calls.length}`, ...(arg as { data?: object })?.data };
          return null;
        },
      }
    );
  const prisma = new Proxy(
    {},
    {
      get: (_, key: string) =>
        key === '$transaction'
          ? async (arg: unknown) =>
              typeof arg === 'function' ? arg(prisma) : Promise.all(arg as unknown[])
          : model(key),
    }
  );
  return { ...actual, prisma };
});

import { GET } from '@/app/api/cron/reset-demo/route';

describe('reset-demo delete order', () => {
  beforeEach(() => {
    calls.length = 0;
    for (const key of Object.keys(args)) delete args[key];
    vi.stubEnv('CRON_SECRET', 'secret');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('removes payments and credit notes before the invoices they restrict', async () => {
    await GET(
      new Request('http://localhost:3000/api/cron/reset-demo', {
        headers: { authorization: 'Bearer secret' },
      })
    );
    const invoices = calls.indexOf('invoice.deleteMany');
    expect(invoices).toBeGreaterThan(-1);
    expect(calls.indexOf('payment.deleteMany')).toBeGreaterThan(-1);
    expect(calls.indexOf('payment.deleteMany')).toBeLessThan(invoices);
    expect(calls.indexOf('creditNote.deleteMany')).toBeGreaterThan(-1);
    expect(calls.indexOf('creditNote.deleteMany')).toBeLessThan(invoices);
  });

  it('starts the invoice sequence after the seeded invoices', async () => {
    await GET(
      new Request('http://localhost:3000/api/cron/reset-demo', {
        headers: { authorization: 'Bearer secret' },
      })
    );
    const seeded = (args['invoice.create'] ?? []).length;
    expect(seeded).toBeGreaterThan(0);
    const invoiceUpdates = (args['numberSequence.updateMany'] ?? []).filter(
      (a) => (a as { where: { type: string } }).where.type === 'invoice'
    ) as { data: { currentValue: number } }[];
    expect(invoiceUpdates.at(-1)?.data.currentValue).toBe(seeded);
  });
});
