/**
 * Wraps the Wolff Prisma adapter to encrypt/decrypt OAuth tokens at rest.
 * Only encrypts access_token and refresh_token fields.
 * Falls back to plaintext if ENCRYPTION_KEY is not set.
 */
import type { Adapter, AdapterAccount } from 'next-auth/adapters';
import { prisma, type PrismaClient } from '@wolff/database';
import { encrypt, decrypt, isEncryptionEnabled } from '@wolff/core/encryption';
import { WolffPrismaAdapter } from './prisma-adapter';

function encryptTokens(account: AdapterAccount): AdapterAccount {
  if (!isEncryptionEnabled()) return account;
  return {
    ...account,
    access_token: account.access_token ? encrypt(account.access_token) : account.access_token,
    refresh_token: account.refresh_token ? encrypt(account.refresh_token) : account.refresh_token,
  };
}

function decryptTokens(account: AdapterAccount | null): AdapterAccount | null {
  if (!account || !isEncryptionEnabled()) return account;
  return {
    ...account,
    access_token: account.access_token ? decrypt(account.access_token) : undefined,
    refresh_token: account.refresh_token ? decrypt(account.refresh_token) : undefined,
  };
}

export function createEncryptedAdapter(client: PrismaClient): Adapter {
  const base = WolffPrismaAdapter(client);
  return {
    ...base,
    linkAccount: (account) => base.linkAccount!(encryptTokens(account)),
    getAccount: async (providerAccountId, provider) =>
      decryptTokens(await base.getAccount!(providerAccountId, provider)),
  };
}

export const encryptedAdapter: Adapter = createEncryptedAdapter(prisma);
