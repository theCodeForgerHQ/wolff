import { describe, expect, it } from 'vitest';
import { generateWorkspaceSlug } from '@/lib/auth/provision-user';

const SUFFIX = /-[0-9a-f]{8}$/;

describe('generateWorkspaceSlug', () => {
  it('slugifies the name and appends a random suffix', () => {
    const slug = generateWorkspaceSlug('Ada Lovelace');
    expect(slug).toMatch(/^ada-lovelace-[0-9a-f]{8}$/);
    expect(generateWorkspaceSlug('Ada Lovelace')).not.toBe(slug);
  });

  it('prefixes names that collide with a top-level route', () => {
    expect(generateWorkspaceSlug('Dashboard')).toMatch(/^ws-dashboard-[0-9a-f]{8}$/);
  });

  it('falls back to a generic slug when the name has no usable characters', () => {
    const slug = generateWorkspaceSlug('日本語');
    expect(slug).toMatch(SUFFIX);
    expect(slug.replace(SUFFIX, '')).toBe('workspace');
  });
});
