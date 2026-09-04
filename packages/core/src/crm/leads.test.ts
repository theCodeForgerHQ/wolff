import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createPrisma, withTenantGuard } from '@wolff/database';
import type { CoreContext } from '../context';
import {
  bulkLeads,
  createLead,
  deleteLead,
  getLead,
  listLeads,
  normalisePhone,
  updateLead,
} from './leads';

const url = process.env.TEST_DATABASE_URL;

describe('normalisePhone', () => {
  it('keeps digits and a leading +, so spellings of one number match', () => {
    expect(normalisePhone('+91 98765-43210')).toBe('+919876543210');
    expect(normalisePhone(' +91 (98765) 43210 ')).toBe('+919876543210');
    expect(normalisePhone('098765 43210')).toBe('09876543210');
  });

  it('gives null for nothing or no digits', () => {
    expect(normalisePhone(null)).toBeNull();
    expect(normalisePhone('')).toBeNull();
    expect(normalisePhone('n/a')).toBeNull();
  });
});

describe.skipIf(!url)('leads (Postgres)', () => {
  const base = createPrisma(url);
  const db = withTenantGuard(base, { mode: 'throw' });
  const run = randomUUID().slice(0, 8);
  const workspaces: string[] = [];
  const users: string[] = [];

  async function workspace(): Promise<CoreContext & { memberId: string }> {
    const user = await base.user.create({
      data: { email: `lead-owner-${run}-${users.length}@example.test`, name: 'Owner' },
    });
    users.push(user.id);
    const ws = await base.workspace.create({
      data: {
        name: 'Leads',
        slug: `leads-${run}-${workspaces.length}`,
        members: { create: { userId: user.id, role: 'owner' } },
      },
    });
    workspaces.push(ws.id);
    return { db, workspaceId: ws.id, memberId: user.id };
  }

  afterAll(async () => {
    await base.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await base.user.deleteMany({ where: { id: { in: users } } });
    await base.$disconnect();
  });

  it('creates a lead with normalised email and phone, and defaults', async () => {
    const ctx = await workspace();

    const lead = await createLead(ctx, {
      name: 'Asha',
      email: '  Asha@Example.COM ',
      phone: '+91 98765 43210',
      company: '',
      message: '',
    });

    expect(lead).toMatchObject({
      workspaceId: ctx.workspaceId,
      email: 'asha@example.com',
      phone: '+919876543210',
      company: null,
      message: null,
      source: 'manual',
      status: 'new',
      ownerId: null,
    });
  });

  it('refuses a second lead with the same email in any case, but not in another workspace', async () => {
    const a = await workspace();
    const b = await workspace();
    await createLead(a, { name: 'One', email: 'dup@example.com' });

    await expect(createLead(a, { name: 'Two', email: 'DUP@example.com' })).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(createLead(b, { name: 'Three', email: 'dup@example.com' })).resolves.toBeTruthy();
  });

  it('refuses an owner who is not a member', async () => {
    const a = await workspace();
    const b = await workspace();

    await expect(createLead(a, { name: 'X', ownerId: b.memberId })).rejects.toMatchObject({
      code: 'validation_error',
    });
    await expect(createLead(a, { name: 'Y', ownerId: a.memberId })).resolves.toMatchObject({
      ownerId: a.memberId,
    });
  });

  it('updates only the fields given, and refuses a foreign or duplicate one', async () => {
    const a = await workspace();
    const b = await workspace();
    const lead = await createLead(a, { name: 'Ravi', email: 'ravi@example.com', company: 'K' });
    await createLead(a, { name: 'Other', email: 'other@example.com' });

    const updated = await updateLead(a, lead.id, { status: 'qualified', phone: '98765 43210' });
    expect(updated).toMatchObject({
      name: 'Ravi',
      company: 'K',
      status: 'qualified',
      phone: '9876543210',
    });

    expect(await updateLead(b, lead.id, { name: 'Stolen' })).toBeNull();
    await expect(updateLead(a, lead.id, { email: 'OTHER@example.com' })).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(updateLead(a, lead.id, { ownerId: b.memberId })).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect((await getLead(a, lead.id))?.name).toBe('Ravi');
  });

  it('soft-deletes a lead and frees its email; a foreign or deleted one is not found', async () => {
    const a = await workspace();
    const b = await workspace();
    const lead = await createLead(a, { name: 'Gone', email: 'gone@example.com' });

    expect(await deleteLead(b, lead.id)).toBe(false);
    expect(await deleteLead(a, lead.id)).toBe(true);
    expect(await deleteLead(a, lead.id)).toBe(false);

    expect(await getLead(a, lead.id)).toBeNull();
    const row = await base.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.email).toBeNull();
    await expect(createLead(a, { name: 'Again', email: 'gone@example.com' })).resolves.toBeTruthy();
  });

  it('lists newest first in pages, with filters and a literal search', async () => {
    const ctx = await workspace();
    const other = await workspace();
    await createLead(other, { name: 'Not mine' });
    const names = ['Ann', 'Ben', 'Cy', '50% Off Ltd', '500 Off Ltd'];
    for (const name of names) {
      await createLead(ctx, {
        name,
        source: name === 'Ben' ? 'widget' : 'manual',
        status: name === 'Cy' ? 'qualified' : 'new',
        ownerId: name === 'Ann' ? ctx.memberId : null,
      });
    }

    const first = await listLeads(ctx, { limit: 2 });
    expect(first.data.map((l) => l.name)).toEqual(['500 Off Ltd', '50% Off Ltd']);
    expect(first.meta.hasMore).toBe(true);
    const second = await listLeads(ctx, { limit: 2, cursor: first.meta.nextCursor! });
    const third = await listLeads(ctx, { limit: 2, cursor: second.meta.nextCursor! });
    expect([...second.data, ...third.data].map((l) => l.name)).toEqual(['Cy', 'Ben', 'Ann']);
    expect(third.meta).toEqual({ hasMore: false, nextCursor: null });

    const names_ = async (filters: object) =>
      (await listLeads(ctx, { limit: 50, filters })).data.map((l) => l.name);
    expect(await names_({ source: 'widget' })).toEqual(['Ben']);
    expect(await names_({ status: 'qualified' })).toEqual(['Cy']);
    expect(await names_({ ownerId: ctx.memberId })).toEqual(['Ann']);
    expect(await names_({ q: 'ann' })).toEqual(['Ann']);
    // % and _ are characters to find, not wildcards.
    expect(await names_({ q: '50%' })).toEqual(['50% Off Ltd']);
  });

  it('caps a page at 100', async () => {
    const ctx = await workspace();
    await base.lead.createMany({
      data: Array.from({ length: 102 }, (_, i) => ({
        workspaceId: ctx.workspaceId,
        name: `L${i}`,
      })),
    });

    const page = await listLeads(ctx, { limit: 500 });

    expect(page.data).toHaveLength(100);
    expect(page.meta.hasMore).toBe(true);
  });

  describe('bulk actions', () => {
    it('sets a status, assigns a member and deletes, only within the workspace', async () => {
      const a = await workspace();
      const b = await workspace();
      const mine = [await createLead(a, { name: 'M1' }), await createLead(a, { name: 'M2' })];
      const theirs = await createLead(b, { name: 'T1' });
      const ids = [...mine.map((l) => l.id), theirs.id];

      expect(await bulkLeads(a, { ids, action: 'status', value: 'contacted' })).toEqual({
        updated: 2,
      });
      expect(await bulkLeads(a, { ids, action: 'assign', value: a.memberId })).toEqual({
        updated: 2,
      });
      const after = await base.lead.findMany({ where: { id: { in: ids } } });
      expect(after.filter((l) => l.status === 'contacted')).toHaveLength(2);
      expect(after.find((l) => l.id === theirs.id)).toMatchObject({ status: 'new', ownerId: null });

      expect(await bulkLeads(a, { ids, action: 'delete' })).toEqual({ updated: 2 });
      expect(await bulkLeads(a, { ids, action: 'delete' })).toEqual({ updated: 0 });
      expect(
        (await base.lead.findUniqueOrThrow({ where: { id: theirs.id } })).deletedAt
      ).toBeNull();
    });

    it('refuses a missing value, an unknown status or action, and a non-member', async () => {
      const a = await workspace();
      const b = await workspace();
      const ids = [(await createLead(a, { name: 'X' })).id];

      for (const input of [
        { ids, action: 'status' as const },
        { ids, action: 'assign' as const },
        { ids, action: 'status' as const, value: 'won' },
        { ids, action: 'archive' as never },
        { ids, action: 'assign' as const, value: b.memberId },
      ]) {
        await expect(bulkLeads(a, input)).rejects.toMatchObject({ code: 'validation_error' });
      }
      expect((await getLead(a, ids[0]!))?.status).toBe('new');
    });
  });
});
