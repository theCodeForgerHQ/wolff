import { describe, it, expect } from 'vitest';
import { hasRole } from '@/lib/workspace/roles';

describe('hasRole', () => {
  it('ranks viewer < member < admin < owner', () => {
    expect(hasRole('viewer', 'member')).toBe(false);
    expect(hasRole('member', 'member')).toBe(true);
    expect(hasRole('member', 'admin')).toBe(false);
    expect(hasRole('admin', 'admin')).toBe(true);
    expect(hasRole('owner', 'admin')).toBe(true);
    expect(hasRole('admin', 'owner')).toBe(false);
  });

  it('denies a role it does not know, whatever the minimum', () => {
    for (const role of ['editor', '', undefined, null, 'OWNER']) {
      expect(hasRole(role as never, 'viewer')).toBe(false);
      // Two unknown values must not rank as equal.
      expect(hasRole(role as never, 'editor' as never)).toBe(false);
    }
  });
});
