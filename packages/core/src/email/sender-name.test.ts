import { describe, expect, it } from 'vitest';
import { senderName } from './sender-name';

describe('senderName', () => {
  it('is the business name from the business profile', () => {
    expect(
      senderName({
        name: 'Demo Workspace',
        businessProfile: { businessName: 'Acme Design Studio' },
      })
    ).toBe('Acme Design Studio');
  });

  it('falls back to the workspace name without a profile or with a blank one', () => {
    expect(senderName({ name: 'Demo Workspace', businessProfile: null })).toBe('Demo Workspace');
    expect(senderName({ name: 'Demo Workspace', businessProfile: { businessName: '  ' } })).toBe(
      'Demo Workspace'
    );
  });
});
