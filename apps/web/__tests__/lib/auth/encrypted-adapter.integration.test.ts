// @vitest-environment node
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrisma } from '@wolff/database';
import { createEncryptedAdapter } from '@/lib/auth/encrypted-adapter';

/**
 * Runs the auth adapter against a real Postgres. Set
 * TEST_DATABASE_URL to a migrated database; CI does. Each run uses its own
 * random email and provider account id and deletes the user afterwards.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('encrypted auth adapter (Postgres)', () => {
  const prisma = createPrisma(url);
  const adapter = createEncryptedAdapter(prisma);
  const run = randomUUID();
  const email = `adapter-${run}@wolff.test`;
  const providerAccountId = `google-${run}`;
  const previousKey = process.env.ENCRYPTION_KEY;
  let userId = '';

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
  });

  afterAll(async () => {
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
    if (previousKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previousKey;
  });

  it('createUser stores the Auth.js user in Wolff columns', async () => {
    const user = await adapter.createUser!({
      id: 'ignored-by-adapter',
      email: email.toUpperCase(),
      name: 'Adapter Test',
      image: 'https://example.com/a.png',
      avatarUrl: null,
      emailVerified: new Date('2026-09-01T00:00:00Z'),
    });
    userId = user.id;

    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(user.email).toBe(email);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.avatarUrl).toBe('https://example.com/a.png');
    expect(row.emailVerifiedAt?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('linkAccount encrypts OAuth tokens at rest', async () => {
    await adapter.linkAccount!({
      userId,
      type: 'oidc',
      provider: 'google',
      providerAccountId,
      access_token: 'ya29.access-token',
      refresh_token: '1//refresh-token',
      expires_at: 1_790_000_000,
      token_type: 'bearer',
      scope: 'openid email profile',
      id_token: 'id-token',
    });

    const row = await prisma.account.findUniqueOrThrow({
      where: { provider_providerAccountId: { provider: 'google', providerAccountId } },
    });
    expect(row.accessToken).toMatch(/^enc:/);
    expect(row.refreshToken).toMatch(/^enc:/);
    expect(row.accessToken).not.toContain('ya29');
    expect(row.idToken).toBe('id-token');
  });

  it('getAccount decrypts the stored tokens', async () => {
    const account = await adapter.getAccount!(providerAccountId, 'google');
    expect(account?.access_token).toBe('ya29.access-token');
    expect(account?.refresh_token).toBe('1//refresh-token');
  });

  it('getUserByAccount finds the linked user', async () => {
    const user = await adapter.getUserByAccount!({ provider: 'google', providerAccountId });
    expect(user?.id).toBe(userId);
    expect(user?.email).toBe(email);
  });

  it('getUserByAccount hides soft-deleted users', async () => {
    await prisma.user.update({ where: { id: userId }, data: { deletedAt: new Date() } });
    const user = await adapter.getUserByAccount!({ provider: 'google', providerAccountId });
    expect(user).toBeNull();
    await prisma.user.update({ where: { id: userId }, data: { deletedAt: null } });
  });

  it('getUserByEmail matches case-insensitively via normalised storage', async () => {
    const user = await adapter.getUserByEmail!(email.toUpperCase());
    expect(user?.id).toBe(userId);
  });

  it('round-trips a verification token once', async () => {
    const token = randomUUID();
    const expires = new Date(Date.now() + 60_000);
    await adapter.createVerificationToken!({ identifier: email, token, expires });
    const used = await adapter.useVerificationToken!({ identifier: email, token });
    expect(used?.token).toBe(token);
    expect(await adapter.useVerificationToken!({ identifier: email, token })).toBeNull();
  });
});
