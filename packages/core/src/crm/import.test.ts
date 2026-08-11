import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma, withTenantGuard } from '@wolff/database';
import { createLead, importLeads, normalisePhone } from './leads';

describe('normalisePhone', () => {
  it.each([
    ['+91 98765 43210', '+919876543210'],
    ['+91-98765-43210', '+919876543210'],
    ['(022) 2345 6789', '02223456789'],
    ['098765.43210', '09876543210'],
    ['  ', null],
    ['call me', null],
  ])('%j → %j', (input, expected) => {
    expect(normalisePhone(input)).toBe(expected);
  });
});

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('lead import (Postgres)', () => {
  const base = createPrisma(url);
  const db = withTenantGuard(base, { mode: 'throw' });
  const run = randomUUID().slice(0, 8);
  let workspaceId = '';
  let otherUserId = '';
  let memberId = '';
  const ctx = () => ({ db, workspaceId });

  beforeAll(async () => {
    const member = await base.user.create({
      data: { email: `member-${run}@example.test`, name: 'Member' },
    });
    const outsider = await base.user.create({
      data: { email: `outsider-${run}@example.test`, name: 'Outsider' },
    });
    memberId = member.id;
    otherUserId = outsider.id;
    const ws = await base.workspace.create({
      data: {
        name: 'Import',
        slug: `import-${run}`,
        members: { create: { userId: member.id, role: 'member' } },
      },
    });
    workspaceId = ws.id;
  });

  beforeEach(async () => {
    await base.lead.deleteMany({ where: { workspaceId } });
  });

  afterAll(async () => {
    await base.lead.deleteMany({ where: { workspaceId } });
    await base.workspaceMember.deleteMany({ where: { workspaceId } });
    await base.workspace.deleteMany({ where: { id: workspaceId } });
    await base.user.deleteMany({ where: { id: { in: [memberId, otherUserId] } } });
    await base.$disconnect();
  });

  it('matches phones written differently as the same lead', async () => {
    await createLead(ctx(), {
      name: 'Priya',
      phone: '+91 98765 43210',
      source: 'manual',
      status: 'new',
    });

    const result = await importLeads(ctx(), {
      leads: [{ name: 'Priya S', phone: '+91-98765-43210', source: 'import', status: 'new' }],
      dedupeBy: ['phone'],
    });

    expect(result).toMatchObject({ created: 0, updated: 1 });
    const leads = await base.lead.findMany({ where: { workspaceId } });
    expect(leads.map((l) => l.phone)).toEqual(['+919876543210']);
  });

  it('matches emails in any case, and keeps the existing name and source', async () => {
    await createLead(ctx(), {
      name: 'Priya Sharma',
      email: 'Priya@Example.com',
      source: 'widget',
      status: 'new',
    });

    const result = await importLeads(ctx(), {
      leads: [
        {
          name: 'P. Sharma',
          email: 'priya@example.com',
          company: 'Kaveri',
          source: 'import',
          status: 'new',
        },
      ],
      dedupeBy: ['email'],
    });

    expect(result).toMatchObject({ created: 0, updated: 1 });
    const lead = await base.lead.findFirstOrThrow({ where: { workspaceId } });
    expect(lead).toMatchObject({ name: 'Priya Sharma', source: 'widget', company: 'Kaveri' });
  });

  it('reports which rows failed and why, instead of a bare count', async () => {
    const result = await importLeads(ctx(), {
      leads: [
        { name: 'Ok', email: `ok-${run}@example.test`, source: 'import', status: 'new' },
        {
          name: 'Bad owner',
          email: `bad-${run}@example.test`,
          ownerId: otherUserId,
          source: 'import',
          status: 'new',
        },
      ],
      dedupeBy: ['email'],
    });

    expect(result.created).toBe(1);
    expect(result.errors).toBe(1);
    expect(result.failures).toEqual([{ row: 1, message: expect.stringMatching(/owner/i) }]);
    expect(await base.lead.count({ where: { workspaceId } })).toBe(1);
  });

  it('accepts an owner who is a member of the workspace', async () => {
    const result = await importLeads(ctx(), {
      leads: [
        {
          name: 'Owned',
          email: `owned-${run}@example.test`,
          ownerId: memberId,
          source: 'import',
          status: 'new',
        },
      ],
      dedupeBy: ['email'],
    });

    expect(result).toMatchObject({ created: 1, errors: 0 });
  });
});
