/** Scopes a secret API key can hold. */
export const API_SCOPES = [
  'leads:read',
  'leads:write',
  'deals:read',
  'deals:write',
  'clients:read',
  'clients:write',
  'quotes:read',
  'quotes:write',
  'invoices:read',
  'invoices:write',
  'payments:read',
  'payments:write',
  'webhooks:manage',
  'reports:read',
  'ai:use',
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

/**
 * What a key created before scopes existed is backfilled with: everything it
 * could already do. `webhooks:manage` is new, so it is not granted silently.
 */
export const LEGACY_KEY_SCOPES: readonly ApiScope[] = API_SCOPES.filter(
  (scope) => scope !== 'webhooks:manage'
);

/** The only scopes a publishable (browser) key may hold. */
export const PUBLISHABLE_SCOPES = ['lead:create', 'invoice:pay'] as const;

export type PublishableScope = (typeof PUBLISHABLE_SCOPES)[number];

/** True when `granted` contains every scope in `required`. Exact match only. */
export function hasScopes(granted: readonly string[], required: readonly string[]): boolean {
  return required.every((scope) => granted.includes(scope));
}
