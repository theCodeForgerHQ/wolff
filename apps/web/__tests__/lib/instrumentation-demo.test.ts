import { afterEach, describe, expect, it, vi } from 'vitest';
import { register } from '../../instrumentation';

afterEach(() => vi.unstubAllEnvs());

describe('web startup in demo mode', () => {
  it('refuses to start without DEMO_EMAIL_REDIRECT', async () => {
    vi.stubEnv('DEMO_MODE', 'true');
    vi.stubEnv('DEMO_EMAIL_REDIRECT', '');
    await expect(register()).rejects.toThrow(/DEMO_EMAIL_REDIRECT/);
  });

  it('starts with one', async () => {
    vi.stubEnv('DEMO_MODE', 'true');
    vi.stubEnv('DEMO_EMAIL_REDIRECT', 'owner@x.test');
    await expect(register()).resolves.toBeUndefined();
  });
});
