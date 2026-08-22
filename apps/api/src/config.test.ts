import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

describe('demo mode configuration', () => {
  it('refuses to start in demo mode without an email redirect', () => {
    expect(() => loadConfig({ DEMO_MODE: 'true' })).toThrow(/DEMO_EMAIL_REDIRECT/);
  });

  it('carries the redirect in demo mode', () => {
    const config = loadConfig({ DEMO_MODE: 'true', DEMO_EMAIL_REDIRECT: 'owner@x.test' });
    expect(config.demoEmailRedirect).toBe('owner@x.test');
  });

  it('has no redirect outside demo mode', () => {
    expect(loadConfig({}).demoEmailRedirect).toBeUndefined();
  });
});
