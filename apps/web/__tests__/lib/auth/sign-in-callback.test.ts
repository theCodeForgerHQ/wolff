// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, User } from 'next-auth';

const db = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  accountFindUnique: vi.fn(),
}));

vi.mock('@wolff/database', () => ({
  prisma: {
    user: { findUnique: db.userFindUnique },
    account: { findUnique: db.accountFindUnique },
  },
}));

import { authConfig } from '@/lib/auth/config';
import { ACCOUNT_DEACTIVATED_ERROR, signInErrorMessage } from '@/lib/auth/errors';

const google: Account = { provider: 'google', providerAccountId: 'g-1', type: 'oidc' };

function signIn(email: string, account: Account | null) {
  const user: User = { id: '', name: null, avatarUrl: null, email };
  return authConfig.callbacks!.signIn!({ user, account });
}

describe('signIn callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.userFindUnique.mockResolvedValue(null);
    db.accountFindUnique.mockResolvedValue(null);
  });

  it('allows a first OAuth sign-in for an unknown email', async () => {
    expect(await signIn('new@wolff.test', google)).toBe(true);
  });

  it('allows an active user', async () => {
    db.userFindUnique.mockResolvedValue({ deletedAt: null });
    expect(await signIn('active@wolff.test', google)).toBe(true);
  });

  it('rejects OAuth sign-in when the email belongs to a soft-deleted user', async () => {
    db.userFindUnique.mockResolvedValue({ deletedAt: new Date('2026-09-01') });

    const result = await signIn('Gone@Wolff.test', google);

    expect(result).toBe(`/login?error=${ACCOUNT_DEACTIVATED_ERROR}`);
    expect(db.userFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'gone@wolff.test' } })
    );
  });

  it('rejects when the linked account belongs to a soft-deleted user with another email', async () => {
    db.accountFindUnique.mockResolvedValue({ user: { deletedAt: new Date('2026-09-01') } });

    const result = await signIn('renamed@wolff.test', google);

    expect(result).toBe(`/login?error=${ACCOUNT_DEACTIVATED_ERROR}`);
  });

  it('leaves credentials sign-in to verifyCredentials', async () => {
    const credentials: Account = {
      provider: 'credentials',
      providerAccountId: 'u1',
      type: 'credentials',
    };

    expect(await signIn('demo@wolff.demo', credentials)).toBe(true);
    expect(db.userFindUnique).not.toHaveBeenCalled();
  });
});

describe('signInErrorMessage', () => {
  it('has no message without an error code', () => {
    expect(signInErrorMessage(null)).toBeNull();
    expect(signInErrorMessage('')).toBeNull();
  });

  it('explains a deactivated account', () => {
    expect(signInErrorMessage(ACCOUNT_DEACTIVATED_ERROR)).toMatch(/deactivated/i);
  });

  it('tells a person whose email already has an account how to get in', () => {
    // Auth.js sends this code when an OAuth email matches another user.
    expect(signInErrorMessage('OAuthAccountNotLinked')).toMatch(
      /already has an account.*password/i
    );
  });

  it('does not echo unknown codes from the query string', () => {
    const message = signInErrorMessage('<script>alert(1)</script>');
    expect(message).toBe('Sign-in failed. Please try again.');
  });
});
