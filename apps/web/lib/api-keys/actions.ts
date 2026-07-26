'use server';

import { randomBytes } from 'crypto';
import { prisma } from '@wolff/database';
import { LEGACY_KEY_SCOPES } from '@wolff/contracts';
import { LEGACY_SECRET_PREFIX, hashApiKey } from '@wolff/core/auth/api-keys';
import { revalidatePath } from 'next/cache';
import { getCurrentUserWorkspace } from '@/lib/workspace/get-current-workspace';

export interface ApiKeyListItem {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

/**
 * Generate a new API key. Returns the raw key ONCE — it's hashed in DB.
 */
export async function generateApiKey(data: {
  name: string;
  expiresAt?: string | null;
}): Promise<{ success: boolean; key?: string; id?: string; error?: string }> {
  const { workspaceId, role } = await getCurrentUserWorkspace();

  if (role !== 'owner' && role !== 'admin') {
    return { success: false, error: 'Only owners and admins can create API keys' };
  }

  if (!data.name?.trim()) {
    return { success: false, error: 'API key name is required' };
  }

  // Generate a secure random key with prefix
  const rawBytes = randomBytes(32);
  // Keys keep the original prefix until the product rename.
  const rawKey = `${LEGACY_SECRET_PREFIX}${rawBytes.toString('hex')}`;
  const keyHash = hashApiKey(rawKey);
  const keyPrefix = rawKey.slice(0, 10);

  await prisma.apiKey.create({
    data: {
      workspaceId,
      name: data.name.trim(),
      keyHash,
      keyPrefix,
      // No scope picker yet: a new key can do what keys could always do.
      scopes: [...LEGACY_KEY_SCOPES],
      expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
    },
  });

  revalidatePath('/settings/api');
  return { success: true, key: rawKey };
}

/**
 * List all active API keys for the workspace (never returns the actual key).
 */
export async function getApiKeys(): Promise<ApiKeyListItem[]> {
  const { workspaceId } = await getCurrentUserWorkspace();

  const keys = await prisma.apiKey.findMany({
    where: { workspaceId, revokedAt: null },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      lastUsedAt: true,
      expiresAt: true,
      createdAt: true,
    },
  });

  return keys;
}

/**
 * Revoke (delete) an API key.
 */
export async function revokeApiKey(id: string): Promise<{ success: boolean; error?: string }> {
  const { workspaceId, role } = await getCurrentUserWorkspace();

  if (role !== 'owner' && role !== 'admin') {
    return { success: false, error: 'Only owners and admins can revoke API keys' };
  }

  const key = await prisma.apiKey.findFirst({
    where: { id, workspaceId, revokedAt: null },
  });

  if (!key) {
    return { success: false, error: 'API key not found' };
  }

  await prisma.apiKey.update({
    where: { id },
    data: { revokedAt: new Date() },
  });

  revalidatePath('/settings/api');
  return { success: true };
}
