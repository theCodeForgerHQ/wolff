import { describe, expect, it } from 'vitest';
import { API_SCOPES, LEGACY_KEY_SCOPES, PUBLISHABLE_SCOPES, hasScopes } from './scopes';

describe('API key scopes', () => {
  it('gives keys created before scopes existed everything except webhooks:manage', () => {
    expect(LEGACY_KEY_SCOPES).not.toContain('webhooks:manage');
    expect([...LEGACY_KEY_SCOPES, 'webhooks:manage'].sort()).toEqual([...API_SCOPES].sort());
  });

  it('limits publishable keys to creating a lead and paying an invoice', () => {
    expect(PUBLISHABLE_SCOPES).toEqual(['lead:create', 'invoice:pay']);
  });

  it('requires every requested scope', () => {
    expect(hasScopes(['invoices:read', 'invoices:write'], ['invoices:read'])).toBe(true);
    expect(hasScopes(['invoices:read'], ['invoices:read', 'invoices:write'])).toBe(false);
    expect(hasScopes([], ['invoices:read'])).toBe(false);
  });

  it('does not treat a read scope as a prefix of anything else', () => {
    expect(hasScopes(['invoices:read'], ['invoices:write'])).toBe(false);
    expect(hasScopes(['invoices'], ['invoices:read'])).toBe(false);
  });
});
