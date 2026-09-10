// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { authConfig } from '@/lib/auth/config';

const authorized = (pathname: string) =>
  (authConfig.callbacks!.authorized as (args: unknown) => boolean)({
    auth: null,
    request: { nextUrl: new URL(`https://app.test${pathname}`) },
  });

describe('pages a logged-out visitor can open', () => {
  it.each(['/terms', '/privacy'])('%s, linked from the sign-up form', (path) => {
    expect(authorized(path)).toBe(true);
  });

  it('still sends the dashboard to login', () => {
    expect(authorized('/dashboard')).toBe(false);
  });
});
