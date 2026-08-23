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

/**
 * Whether any usable publishable key lists `origin`. A CORS preflight cannot
 * carry the key (the browser sends only the header names), so this is the
 * most the preflight can check; the real request is then held to its own
 * key's list by the publishable-key middleware. Same rules as that check:
 * exact match, revoked and expired keys don't count.
 */
export async function isPublishableKeyOrigin(
  db: Db,
  origin: string,
  now: Date = new Date()
): Promise<boolean> {
  // Exempt from the tenant guard: the caller has no workspace yet.
  const key = await db.$unscoped.apiKey.findFirst({
    where: {
      kind: 'publishable',
      revokedAt: null,
      allowedOrigins: { has: origin },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date(now.getTime() - CLOCK_SKEW_MS) } }],
    },
    select: { id: true },
  });
  return key !== null;
}

const MAX_ALLOWED_ORIGINS = 20;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export type AllowedOriginsResult = { ok: true; origins: string[] } | { ok: false; error: string };

/**
 * Validates the origins a publishable key may be used from. Each
 * entry must be exactly an origin (scheme, host, optional port; no path, no
 * wildcard), https except on loopback hosts for local development. The API
 * compares the browser's Origin header to these strings byte for byte, so
 * they are stored in the form browsers send.
 */
export function normaliseAllowedOrigins(input: readonly string[]): AllowedOriginsResult {
  const origins: string[] = [];
  for (const raw of input) {
    const value = raw.trim();
    if (!value) continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return { ok: false, error: `"${value}" is not an origin (e.g. https://shop.example.com)` };
    }
    if (
      url.origin === 'null' ||
      url.origin !== value.replace(/\/$/, '') ||
      url.hostname.includes('*')
    ) {
      return { ok: false, error: `"${value}" is not an origin (e.g. https://shop.example.com)` };
    }
    if (url.protocol !== 'https:' && !LOOPBACK_HOSTS.has(url.hostname)) {
      return { ok: false, error: `"${value}" must use https` };
    }
    if (!origins.includes(url.origin)) origins.push(url.origin);
  }
  if (origins.length === 0) {
    return { ok: false, error: 'A publishable key needs at least one allowed origin' };
  }
  if (origins.length > MAX_ALLOWED_ORIGINS) {
    return { ok: false, error: `At most ${MAX_ALLOWED_ORIGINS} allowed origins` };
  }
  return { ok: true, origins };
}
