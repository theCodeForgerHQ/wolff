'use server';

import { prisma } from '@wolff/database';
import { LEGACY_KEY_SCOPES, PUBLISHABLE_SCOPES } from '@wolff/contracts';
import { generateApiKey as mintKey, normaliseAllowedOrigins } from '@wolff/core/auth/api-keys';
import { revalidatePath } from 'next/cache';
import { getCurrentUserWorkspace } from '@/lib/workspace/get-current-workspace';

export interface ApiKeyListItem {
  id: string;
  name: string;
  kind: 'secret' | 'publishable';
  allowedOrigins: string[];
  keyPrefix: string;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

/**
 * Generate a new API key. Returns the raw key ONCE — it's hashed in DB.
 *
 * A publishable key is for the embeddable widget: it holds only
 * the widget scopes and works only from the listed origins, so at least one
 * valid origin is required.
 */
export async function generateApiKey(data: {
  name: string;
  expiresAt?: string | null;
  kind?: 'secret' | 'publishable';
  allowedOrigins?: string[];
}): Promise<{ success: boolean; key?: string; id?: string; error?: string }> {
  const { workspaceId, role } = await getCurrentUserWorkspace();

  if (role !== 'owner' && role !== 'admin') {
    return { success: false, error: 'Only owners and admins can create API keys' };
  }

  if (!data.name?.trim()) {
    return { success: false, error: 'API key name is required' };
  }

  if (data.kind === 'publishable') {
    const origins = normaliseAllowedOrigins(data.allowedOrigins ?? []);
    if (!origins.ok) return { success: false, error: origins.error };
    const generated = mintKey('publishable');
    await prisma.apiKey.create({
      data: {
        workspaceId,
        name: data.name.trim(),
        keyHash: generated.keyHash,
        keyPrefix: generated.keyPrefix,
        kind: 'publishable',
        scopes: [...PUBLISHABLE_SCOPES],
        allowedOrigins: origins.origins,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
      },
    });
    revalidatePath('/settings/api');
    return { success: true, key: generated.raw };
  }

  // New secret keys use the product prefix; older qc_sk_ keys still work.
  const generatedSecret = mintKey('secret');

  await prisma.apiKey.create({
    data: {
      workspaceId,
      name: data.name.trim(),
      keyHash: generatedSecret.keyHash,
      keyPrefix: generatedSecret.keyPrefix,
      // No scope picker yet: a new key can do what keys could always do.
      scopes: [...LEGACY_KEY_SCOPES],
      expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
    },
  });

  revalidatePath('/settings/api');
  return { success: true, key: generatedSecret.raw };
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
      kind: true,
      allowedOrigins: true,
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
