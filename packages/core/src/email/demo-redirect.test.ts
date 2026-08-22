import { describe, expect, it } from 'vitest';
import { demoEmailRedirect, redirectForDemo } from './demo-redirect';

describe('demoEmailRedirect', () => {
  it('is off outside demo mode', () => {
    expect(demoEmailRedirect({})).toBeUndefined();
    expect(demoEmailRedirect({ DEMO_MODE: 'false', DEMO_EMAIL_REDIRECT: 'me@x.test' })).toBe(
      undefined
    );
  });

  it('returns the configured address in demo mode', () => {
    expect(demoEmailRedirect({ DEMO_MODE: 'true', DEMO_EMAIL_REDIRECT: ' me@x.test ' })).toBe(
      'me@x.test'
    );
  });

  it.each([undefined, '', 'not-an-address', 'a@x.test,b@x.test'])(
    'refuses demo mode with DEMO_EMAIL_REDIRECT=%j',
    (redirect) => {
      expect(() => demoEmailRedirect({ DEMO_MODE: 'true', DEMO_EMAIL_REDIRECT: redirect })).toThrow(
        /DEMO_EMAIL_REDIRECT/
      );
    }
  );

  it('refuses a DEMO_MODE value it does not understand', () => {
    expect(() => demoEmailRedirect({ DEMO_MODE: 'yes' })).toThrow(/DEMO_MODE/);
  });
});

describe('redirectForDemo', () => {
  it('sends only to the redirect and names every intended recipient in the subject', () => {
    const message = redirectForDemo(
      {
        to: ['client@acme.test', 'billing@acme.test'],
        cc: ['cc@acme.test'],
        bcc: ['bcc@acme.test'],
        subject: 'Invoice INV-1',
      },
      'owner@x.test'
    );

    expect(message).toEqual({
      to: ['owner@x.test'],
      cc: undefined,
      bcc: undefined,
      subject:
        '[demo, to client@acme.test, billing@acme.test, cc cc@acme.test, bcc bcc@acme.test] Invoice INV-1',
    });
  });

  it('accepts a single recipient string', () => {
    expect(redirectForDemo({ to: 'c@acme.test', subject: 'Hi' }, 'o@x.test')).toMatchObject({
      to: ['o@x.test'],
      subject: '[demo, to c@acme.test] Hi',
    });
  });
});
