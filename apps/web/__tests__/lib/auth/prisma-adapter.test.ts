import { describe, expect, it } from 'vitest';
import type { Account } from '@wolff/database';
import { toAccountData, toAdapterAccount, toAdapterUser } from '@/lib/auth/prisma-adapter';

describe('WolffPrismaAdapter mapping', () => {
  it('maps a database user to the Auth.js shape', () => {
    const verified = new Date('2026-09-01T00:00:00Z');
    expect(
      toAdapterUser({
        id: 'u1',
        email: 'a@b.dev',
        name: 'A',
        avatarUrl: 'https://img/a.png',
        emailVerifiedAt: verified,
      })
    ).toEqual({
      id: 'u1',
      email: 'a@b.dev',
      name: 'A',
      avatarUrl: 'https://img/a.png',
      image: 'https://img/a.png',
      emailVerified: verified,
    });
  });

  it('maps Auth.js snake_case token fields onto the camelCase columns', () => {
    const data = toAccountData({
      userId: 'u1',
      type: 'oidc',
      provider: 'google',
      providerAccountId: 'g-1',
      access_token: 'at',
      refresh_token: 'rt',
      expires_at: 1790000000,
      token_type: 'bearer',
      scope: 'openid email',
      id_token: 'idt',
      session_state: 'st',
    });
    expect(data).toEqual({
      userId: 'u1',
      type: 'oidc',
      provider: 'google',
      providerAccountId: 'g-1',
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: 1790000000,
      tokenType: 'bearer',
      scope: 'openid email',
      idToken: 'idt',
      sessionState: 'st',
    });
  });

  it('stores null for token fields the provider did not send', () => {
    const data = toAccountData({
      userId: 'u1',
      type: 'oauth',
      provider: 'github',
      providerAccountId: '42',
    });
    expect(data.accessToken).toBeNull();
    expect(data.refreshToken).toBeNull();
    expect(data.sessionState).toBeNull();
  });

  it('round-trips an account through the database shape', () => {
    const row: Account = {
      id: 'acc-1',
      userId: 'u1',
      type: 'oidc',
      provider: 'google',
      providerAccountId: 'g-1',
      accessToken: 'at',
      refreshToken: null,
      expiresAt: 5,
      tokenType: 'bearer',
      scope: null,
      idToken: null,
      sessionState: null,
    };
    const account = toAdapterAccount(row);
    expect(account.access_token).toBe('at');
    expect(account.refresh_token).toBeUndefined();
    expect(toAccountData(account)).toEqual({
      userId: 'u1',
      type: 'oidc',
      provider: 'google',
      providerAccountId: 'g-1',
      accessToken: 'at',
      refreshToken: null,
      expiresAt: 5,
      tokenType: 'bearer',
      scope: null,
      idToken: null,
      sessionState: null,
    });
  });
});
