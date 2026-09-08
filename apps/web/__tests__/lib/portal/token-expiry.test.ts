// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

/**
 * Evaluates the `where` a query was given against rows, for the shapes the
 * portal queries use: plain equality, null, { gt }, OR and AND. Nested
 * objects (relation filters) are not under test and pass.
 */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as Record<string, unknown>[]).every((c) => matches(row, c));
    if (key === 'OR') return (cond as Record<string, unknown>[]).some((c) => matches(row, c));
    const value = row[key];
    if (cond === null) return value === null || value === undefined;
    if (cond && typeof cond === 'object' && 'gt' in cond) {
      return value instanceof Date && value > (cond as { gt: Date }).gt;
    }
    if (cond && typeof cond === 'object') return true;
    return value === cond;
  });
}

const rows = vi.hoisted(() => [] as Record<string, unknown>[]);
const findFirst = vi.hoisted(() => vi.fn());

vi.mock('@wolff/database', () => ({
  prisma: new Proxy(
    {},
    {
      get: () =>
        new Proxy(
          {},
          { get: (_t, op) => (op === 'findFirst' ? findFirst : vi.fn().mockResolvedValue(null)) }
        ),
    }
  ),
  Prisma: {},
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));

import { getInvoiceByAccessToken } from '@/lib/invoices/portal-actions';
import { getQuoteByAccessToken } from '@/lib/quotes/portal-actions';

const past = new Date(Date.now() - 86_400_000);
const future = new Date(Date.now() + 86_400_000);
const base = { deletedAt: null, workspaceId: 'ws-1', status: 'sent' };
rows.push(
  { ...base, id: 'expired', accessToken: 'tok-expired', accessTokenExpiresAt: past },
  { ...base, id: 'live', accessToken: 'tok-live', accessTokenExpiresAt: future },
  { ...base, id: 'forever', accessToken: 'tok-forever', accessTokenExpiresAt: null }
);

/** Which row the getter's first token lookup selected, if any. */
async function lookup(get: (token: string) => Promise<unknown>, token: string) {
  findFirst.mockReset();
  let selected: string | null = null;
  findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    const row = rows.find((r) => matches(r, where)) ?? null;
    if (selected === null && 'accessToken' in where) selected = (row?.id as string) ?? 'none';
    return null; // Stop the getter here: only the lookup is under test.
  });
  await get(token).catch(() => undefined);
  return selected;
}

describe('portal links honour their expiry', () => {
  it.each([
    ['invoice', getInvoiceByAccessToken],
    ['quote', getQuoteByAccessToken],
  ] as const)('a %s link past its expiry finds nothing', async (_kind, get) => {
    expect(await lookup(get, 'tok-expired')).toBe('none');
  });

  it.each([
    ['invoice', getInvoiceByAccessToken],
    ['quote', getQuoteByAccessToken],
  ] as const)(
    'a %s link before its expiry, or with none, finds its document',
    async (_kind, get) => {
      expect(await lookup(get, 'tok-live')).toBe('live');
      expect(await lookup(get, 'tok-forever')).toBe('forever');
    }
  );
});
