import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrisma, withTenantGuard } from '@wolff/database';
import {
  authenticateApiKey,
  generateApiKey,
  hashApiKey,
  keyKindOf,
  normaliseAllowedOrigins,
  SECRET_KEY_PREFIXES,
} from './api-keys';

describe('key format', () => {
  it('recognises the legacy and the current secret prefix, and the publishable prefix', () => {
    expect(SECRET_KEY_PREFIXES).toContain('qc_sk_');
    expect(keyKindOf('qc_sk_abc')).toBe('secret');
    expect(keyKindOf(generateApiKey('secret').raw)).toBe('secret');
    expect(keyKindOf(generateApiKey('publishable').raw)).toBe('publishable');
  });

  it.each(['', 'sk_live_abc', 'Bearer qc_sk_abc', 'qc_sk_', 'qc_pk_abc', ' qc_sk_abc'])(
    'rejects %j',
    (raw) => {
      expect(keyKindOf(raw)).toBeNull();
    }
  );

  it('generates 32 random bytes, a SHA-256 hash and a short display prefix', () => {
    const a = generateApiKey('secret');
    const b = generateApiKey('secret');

    expect(a.raw).not.toBe(b.raw);
    expect(a.raw.split('_sk_')[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(a.keyHash).toBe(hashApiKey(a.raw));
    expect(a.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.raw.startsWith(a.keyPrefix)).toBe(true);
    expect(a.keyPrefix.length).toBeLessThanOrEqual(12);
  });
});

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('authenticateApiKey (Postgres)', () => {
  const base = createPrisma(url);
  const db = withTenantGuard(base, { mode: 'throw' });
  const run = randomUUID();
  let workspaceId = '';

  const store = async (
    raw: string,
    data: { revokedAt?: Date; expiresAt?: Date; scopes?: string[]; kind?: 'secret' | 'publishable' }
  ) =>
    base.apiKey.create({
      data: {
        workspaceId,
        name: 'test',
        keyHash: hashApiKey(raw),
        keyPrefix: raw.slice(0, 10),
        ...data,
      },
    });

  beforeAll(async () => {
    workspaceId = (
      await base.workspace.create({ data: { name: 'Key Auth', slug: `key-auth-${run}` } })
    ).id;
  });

  afterAll(async () => {
    if (workspaceId) await base.workspace.delete({ where: { id: workspaceId } });
    await base.$disconnect();
  });

  it('resolves a stored key to its workspace, scopes and limits', async () => {
    const raw = `qc_sk_${run}a`;
    const stored = await store(raw, { scopes: ['invoices:read'] });

    const result = await authenticateApiKey(db, raw);

    expect(result).toEqual({
      ok: true,
      key: {
        id: stored.id,
        workspaceId,
        kind: 'secret',
        scopes: ['invoices:read'],
        allowedOrigins: [],
        rateLimitPerMin: 120,
      },
    });
  });

  it('rejects a key that is not stored, without saying which part was wrong', async () => {
    expect(await authenticateApiKey(db, `qc_sk_${run}-unknown`)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(await authenticateApiKey(db, 'not-a-key')).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a revoked key', async () => {
    const raw = `qc_sk_${run}b`;
    await store(raw, { revokedAt: new Date() });

    expect(await authenticateApiKey(db, raw)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects an expired key, with 5 seconds of tolerance for clock skew', async () => {
    const raw = `qc_sk_${run}c`;
    const expiresAt = new Date('2026-09-30T12:00:00Z');
    await store(raw, { expiresAt });

    const at = (ms: number) => new Date(expiresAt.getTime() + ms);
    expect((await authenticateApiKey(db, raw, at(4_000))).ok).toBe(true);
    expect(await authenticateApiKey(db, raw, at(6_000))).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a key whose prefix says secret but which is stored as publishable', async () => {
    const raw = `qc_sk_${run}d`;
    await store(raw, { kind: 'publishable' });

    expect(await authenticateApiKey(db, raw)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('records when the key was last used', async () => {
    const raw = `qc_sk_${run}e`;
    const stored = await store(raw, {});
    const now = new Date('2026-09-30T12:00:00Z');

    await authenticateApiKey(db, raw, now);

    await expect
      .poll(
        async () => (await base.apiKey.findUniqueOrThrow({ where: { id: stored.id } })).lastUsedAt
      )
      .toEqual(now);
  });
});

describe('normaliseAllowedOrigins', () => {
  it('keeps exact origins, trimmed and without duplicates', () => {
    expect(
      normaliseAllowedOrigins([
        ' https://shop.example.com ',
        'https://shop.example.com',
        'http://localhost:5173',
      ])
    ).toEqual({ ok: true, origins: ['https://shop.example.com', 'http://localhost:5173'] });
  });

  it.each([
    [[], 'at least one'],
    [['shop.example.com'], 'not an origin'],
    [['https://shop.example.com/contact'], 'not an origin'],
    [['https://*.example.com'], 'not an origin'],
    [['http://shop.example.com'], 'https'],
    [['javascript:alert(1)'], 'not an origin'],
    [['*'], 'not an origin'],
  ])('refuses %j (%s)', (input, reason) => {
    const result = normaliseAllowedOrigins(input);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toContain(reason);
  });

  it('refuses more than 20 origins', () => {
    const many = Array.from({ length: 21 }, (_, i) => `https://s${i}.example.com`);
    expect(normaliseAllowedOrigins(many).ok).toBe(false);
  });
});
