import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../context';
import { PRODUCT_SLUG } from '../brand';

/**
 * API key authentication. A key is looked up by the SHA-256 of
 * its full value on a unique column, so the comparison happens in the index
 * and needs no constant-time compare here.
 */
export type ApiKeyKind = 'secret' | 'publishable';

/** `qc_sk_` is the prefix of keys issued so far; it stays valid. */
export const LEGACY_SECRET_PREFIX = 'qc_sk_';
export const SECRET_KEY_PREFIX = `${PRODUCT_SLUG}_sk_`;
export const PUBLISHABLE_KEY_PREFIX = `${PRODUCT_SLUG}_pk_`;
export const SECRET_KEY_PREFIXES = [LEGACY_SECRET_PREFIX, SECRET_KEY_PREFIX] as const;

const CLOCK_SKEW_MS = 5_000;
const DISPLAY_PREFIX_LENGTH = 12;

export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** The kind a raw key claims by its prefix, or null when it is not a key at all. */
export function keyKindOf(raw: string): ApiKeyKind | null {
  for (const prefix of SECRET_KEY_PREFIXES) {
    if (raw.startsWith(prefix) && raw.length > prefix.length) return 'secret';
  }
  if (raw.startsWith(PUBLISHABLE_KEY_PREFIX) && raw.length > PUBLISHABLE_KEY_PREFIX.length) {
    return 'publishable';
  }
  return null;
}

export interface GeneratedApiKey {
  /** Shown to the user once and never stored. */
  raw: string;
  keyHash: string;
  /** The first characters, stored so the key can be recognised in a list. */
  keyPrefix: string;
}

export function generateApiKey(kind: ApiKeyKind): GeneratedApiKey {
  const prefix = kind === 'secret' ? SECRET_KEY_PREFIX : PUBLISHABLE_KEY_PREFIX;
  const raw = `${prefix}${randomBytes(32).toString('hex')}`;
  return { raw, keyHash: hashApiKey(raw), keyPrefix: raw.slice(0, DISPLAY_PREFIX_LENGTH) };
}

export interface AuthenticatedApiKey {
  id: string;
  workspaceId: string;
  kind: ApiKeyKind;
  scopes: string[];
  allowedOrigins: string[];
  rateLimitPerMin: number;
}

export type ApiKeyAuthResult =
  | { ok: true; key: AuthenticatedApiKey }
  | { ok: false; reason: 'malformed' | 'invalid' | 'expired' };

/**
 * Resolves a raw key to the workspace it acts for. Unknown, revoked and
 * wrong-kind keys all return `invalid`, so a caller cannot tell them apart.
 */
export async function authenticateApiKey(
  db: Db,
  raw: string,
  now: Date = new Date()
): Promise<ApiKeyAuthResult> {
  const claimedKind = keyKindOf(raw);
  if (!claimedKind) return { ok: false, reason: 'malformed' };

  // Exemption from the tenant guard: the key is what tells us the
  // workspace, so this lookup cannot be scoped by one.
  const apiKey = await db.$unscoped.apiKey.findUnique({
    where: { keyHash: hashApiKey(raw) },
    select: {
      id: true,
      workspaceId: true,
      kind: true,
      scopes: true,
      allowedOrigins: true,
      rateLimitPerMin: true,
      revokedAt: true,
      expiresAt: true,
    },
  });

  if (!apiKey || apiKey.revokedAt || apiKey.kind !== claimedKind) {
    return { ok: false, reason: 'invalid' };
  }
  if (apiKey.expiresAt && apiKey.expiresAt.getTime() + CLOCK_SKEW_MS < now.getTime()) {
    return { ok: false, reason: 'expired' };
  }

  // Best effort: a failed timestamp write must not fail the request.
  db.apiKey
    .updateMany({
      where: { id: apiKey.id, workspaceId: apiKey.workspaceId },
      data: { lastUsedAt: now },
    })
    .catch(() => {});

  return {
    ok: true,
    key: {
      id: apiKey.id,
      workspaceId: apiKey.workspaceId,
      kind: apiKey.kind,
      scopes: apiKey.scopes,
      allowedOrigins: apiKey.allowedOrigins,
      rateLimitPerMin: apiKey.rateLimitPerMin,
    },
  };
}
