// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildContentSecurityPolicy, createNonce } from '@/lib/security/csp';

const directives = (policy: string) =>
  Object.fromEntries(
    policy.split(';').map((part) => {
      const [name, ...values] = part.trim().split(/\s+/);
      return [name, values];
    })
  ) as Record<string, string[]>;

describe('Content-Security-Policy', () => {
  const production = directives(
    buildContentSecurityPolicy({ nonce: 'abc123', isDev: false, sentryOrigin: null })
  );

  it('allows scripts by nonce, without unsafe-inline or unsafe-eval', () => {
    expect(production['script-src']).toEqual(
      expect.arrayContaining(["'self'", "'nonce-abc123'", "'strict-dynamic'"])
    );
    expect(production['script-src']).not.toContain("'unsafe-inline'");
    expect(production['script-src']).not.toContain("'unsafe-eval'");
  });

  it('lets Stripe and Razorpay checkout load, frame and call home', () => {
    expect(production['script-src']).toEqual(
      expect.arrayContaining(['https://js.stripe.com', 'https://checkout.razorpay.com'])
    );
    expect(production['frame-src']).toEqual(
      expect.arrayContaining(['https://js.stripe.com', 'https://checkout.razorpay.com'])
    );
    expect(production['connect-src']).toEqual(
      expect.arrayContaining(['https://api.stripe.com', 'https://api.razorpay.com'])
    );
  });

  it('locks down everything else', () => {
    expect(production['default-src']).toEqual(["'self'"]);
    expect(production['object-src']).toEqual(["'none'"]);
    expect(production['base-uri']).toEqual(["'self'"]);
    expect(production['frame-ancestors']).toEqual(["'none'"]);
  });

  it('adds unsafe-eval only in development (React needs it for its dev tooling)', () => {
    const dev = directives(buildContentSecurityPolicy({ nonce: 'n', isDev: true }));
    expect(dev['script-src']).toContain("'unsafe-eval'");
  });

  it('adds the Sentry ingest origin when Sentry is on', () => {
    const withSentry = directives(
      buildContentSecurityPolicy({
        nonce: 'n',
        isDev: false,
        sentryOrigin: 'https://o1.ingest.sentry.io',
      })
    );
    expect(withSentry['connect-src']).toContain('https://o1.ingest.sentry.io');
  });

  it('makes a fresh, unguessable nonce each time', () => {
    const a = createNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(createNonce()).not.toBe(a);
  });

  it('is defined in one place: neither next.config.ts nor vercel.json sets a CSP', () => {
    for (const file of ['next.config.ts', 'vercel.json']) {
      const text = readFileSync(join(__dirname, '../../..', file), 'utf8');
      expect(text, file).not.toContain('Content-Security-Policy');
    }
  });
});
