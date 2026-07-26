import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEGACY_KEY_SCOPES } from '@wolff/contracts';
import { createPrisma } from '../src/client';
import { backfillApiKeyScopes } from './backfill-api-key-scopes';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('backfill-api-key-scopes (Postgres)', () => {
  const db = createPrisma(url);
  const run = randomUUID();
  let workspaceId = '';

  const createKey = (name: string, data: { scopes?: string[]; kind?: 'secret' | 'publishable' }) =>
    db.apiKey.create({
      data: { workspaceId, name, keyHash: `${run}-${name}`, keyPrefix: 'qc_sk_test', ...data },
    });
  const scopesOf = async (id: string) =>
    (await db.apiKey.findUniqueOrThrow({ where: { id } })).scopes;

  beforeAll(async () => {
    const workspace = await db.workspace.create({
      data: { name: 'Scope Backfill', slug: `scope-backfill-${run}` },
    });
    workspaceId = workspace.id;
  });

  afterAll(async () => {
    if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
    await db.$disconnect();
  });

  it('grants a secret key without scopes what it could already do', async () => {
    const legacy = await createKey('legacy', {});

    await backfillApiKeyScopes(db);

    expect(await scopesOf(legacy.id)).toEqual([...LEGACY_KEY_SCOPES]);
    expect(await scopesOf(legacy.id)).not.toContain('webhooks:manage');
  });

  it('leaves keys that already have scopes, and publishable keys, alone', async () => {
    const narrow = await createKey('narrow', { scopes: ['invoices:read'] });
    const publishable = await createKey('publishable', { kind: 'publishable' });

    await backfillApiKeyScopes(db);

    expect(await scopesOf(narrow.id)).toEqual(['invoices:read']);
    expect(await scopesOf(publishable.id)).toEqual([]);
  });

  it('changes nothing on a second run', async () => {
    await backfillApiKeyScopes(db);

    expect(await backfillApiKeyScopes(db)).toBe(0);
  });
});
