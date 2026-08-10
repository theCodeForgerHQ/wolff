import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPrisma } from './client';
import {
  PARENT_SCOPED_MODELS,
  TenantScopeError,
  WORKSPACE_SCOPED_MODELS,
  findTenantViolation,
  withTenantGuard,
} from './tenant-guard';

describe('findTenantViolation', () => {
  const ws = 'ws-1';

  it.each([
    ['findMany', { where: { workspaceId: ws } }],
    ['findFirst', { where: { id: 'x', workspaceId: ws } }],
    ['count', { where: { workspaceId: { equals: ws } } }],
    ['updateMany', { where: { AND: [{ status: 'sent' }, { workspaceId: ws }] }, data: {} }],
    ['update', { where: { id: 'x', workspaceId: ws }, data: {} }],
    ['delete', { where: { workspaceId_email: { workspaceId: ws, email: 'a@b.c' } } }],
    ['aggregate', { where: { workspaceId: { in: [ws] } } }],
  ])('accepts Invoice.%s with a workspace predicate', (operation, args) => {
    expect(findTenantViolation('Invoice', operation, args)).toBeNull();
  });

  it.each([
    ['findMany', undefined, 'no arguments'],
    ['findMany', {}, 'no where'],
    ['findFirst', { where: { id: 'x' } }, 'id only'],
    ['update', { where: { id: 'x' }, data: {} }, 'update by id only'],
    ['deleteMany', { where: {} }, 'empty where'],
    ['count', { where: { workspaceId: undefined } }, 'undefined workspace'],
    ['findMany', { where: { workspaceId: '' } }, 'empty workspace'],
    ['findMany', { where: { workspaceId: null } }, 'null workspace'],
    ['findMany', { where: { workspaceId: { not: ws } } }, 'negated workspace'],
    ['findMany', { where: { workspaceId: { in: [] } } }, 'empty in-list'],
    ['findMany', { where: { OR: [{ workspaceId: ws }, { id: 'x' }] } }, 'workspace only in OR'],
    ['findMany', { where: { NOT: { workspaceId: ws } } }, 'workspace only in NOT'],
  ])('rejects Invoice.%s with %j (%s)', (operation, args, _reason) => {
    expect(findTenantViolation('Invoice', operation, args)).toMatch(/workspaceId/);
  });

  it('scopes line items and events through their parent', () => {
    expect(
      findTenantViolation('InvoiceLineItem', 'findMany', {
        where: { invoice: { workspaceId: ws } },
      })
    ).toBeNull();
    expect(
      findTenantViolation('QuoteEvent', 'findMany', {
        where: { quote: { is: { workspaceId: ws } } },
      })
    ).toBeNull();
    expect(
      findTenantViolation('InvoiceLineItem', 'findMany', { where: { invoiceId: 'inv-1' } })
    ).toMatch(/invoice/);
  });

  it('ignores models and operations outside the list', () => {
    expect(findTenantViolation('User', 'findMany', {})).toBeNull();
    expect(findTenantViolation('Invoice', 'create', { data: {} })).toBeNull();
    expect(findTenantViolation('Invoice', 'findUnique', { where: { id: 'x' } })).toBeNull();
  });

  it('lists only models that have the column or the parent relation', () => {
    const schema = readFileSync(join(__dirname, '../prisma/schema.prisma'), 'utf8');
    const fieldsOf = (model: string) => {
      const body = new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, 'm').exec(schema)?.[1] ?? '';
      return body.split('\n').map((line) => line.trim().split(/\s+/)[0]);
    };

    for (const name of WORKSPACE_SCOPED_MODELS) {
      expect(fieldsOf(name), name).toContain('workspaceId');
    }
    for (const [name, parent] of Object.entries(PARENT_SCOPED_MODELS)) {
      expect(fieldsOf(name), name).toContain(parent);
    }
  });

  it('includes CRM models in workspace-scoped guard', () => {
    for (const name of ['Lead', 'Pipeline', 'Stage', 'Deal', 'DealActivity']) {
      expect(WORKSPACE_SCOPED_MODELS).toContain(name);
    }
  });

  it('includes every model that owns a workspaceId column', () => {
    const schema = readFileSync(join(__dirname, '../prisma/schema.prisma'), 'utf8');
    const modelRe = /^model (\w+) \{([\s\S]*?)^\}/gm;
    let match: RegExpExecArray | null;
    while ((match = modelRe.exec(schema)) !== null) {
      const [, name, body] = match;
      if (/^\s+workspaceId\s+/m.test(body ?? '')) {
        expect(WORKSPACE_SCOPED_MODELS).toContain(name);
      }
    }
  });
});

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('withTenantGuard (Postgres)', () => {
  const base = createPrisma(url);
  const db = withTenantGuard(base, { mode: 'throw' });
  const run = randomUUID();
  const ids: string[] = [];

  beforeAll(async () => {
    for (const name of ['a', 'b']) {
      const workspace = await base.workspace.create({
        data: {
          name: `Guard ${name}`,
          slug: `guard-${name}-${run}`,
          clients: { create: { name: `Client ${name}`, email: `${name}-${run}@example.test` } },
        },
      });
      ids.push(workspace.id);
    }
  });

  afterAll(async () => {
    await base.client.deleteMany({ where: { workspaceId: { in: ids } } });
    await base.workspace.deleteMany({ where: { id: { in: ids } } });
    await base.$disconnect();
  });

  it('runs a scoped query and returns only that workspace', async () => {
    const clients = await db.client.findMany({ where: { workspaceId: ids[0]! } });

    expect(clients.map((c) => c.name)).toEqual(['Client a']);
  });

  it('throws before the database is asked when the workspace is missing', async () => {
    await expect(db.client.findMany({ where: { name: 'Client b' } })).rejects.toBeInstanceOf(
      TenantScopeError
    );
    await expect(db.client.count()).rejects.toBeInstanceOf(TenantScopeError);
  });

  it('keeps guarding inside a transaction', async () => {
    await expect(
      db.$transaction((tx) => tx.client.updateMany({ where: {}, data: { notes: 'leak' } }))
    ).rejects.toBeInstanceOf(TenantScopeError);

    expect(await base.client.count({ where: { workspaceId: { in: ids }, notes: 'leak' } })).toBe(0);
  });

  it('offers an explicit way out for the documented exemptions', async () => {
    const all = await db.$unscoped.client.findMany({
      where: { email: { endsWith: `${run}@example.test` } },
    });

    expect(all).toHaveLength(2);
  });

  it('reports instead of throwing in report mode, and still runs the query', async () => {
    const onViolation = vi.fn();
    const reporting = withTenantGuard(base, { mode: 'report', onViolation });

    const count = await reporting.client.count({
      where: { email: { endsWith: `${run}@example.test` } },
    });

    expect(count).toBe(2);
    expect(onViolation).toHaveBeenCalledTimes(1);
    expect(onViolation.mock.calls[0]![0]).toMatchObject({ model: 'Client', operation: 'count' });
  });
});
