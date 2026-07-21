/**
 * Shared Sentry options for the browser, Node.js and Edge SDKs.
 *
 * Sentry is optional: with no DSN the SDK is initialised with
 * `enabled: false`, so it records nothing and makes no network calls. Set
 * SENTRY_DSN (server) and NEXT_PUBLIC_SENTRY_DSN (browser, inlined at build
 * time) to turn it on.
 */
export interface SentryRuntimeOptions {
  dsn: string | undefined;
  enabled: boolean;
  environment: string;
  release: string | undefined;
  tracesSampleRate: number;
  sendDefaultPii: false;
}

const DEFAULT_TRACES_SAMPLE_RATE = 0.1;

function parseSampleRate(value: string | undefined): number {
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : DEFAULT_TRACES_SAMPLE_RATE;
}

export function sentryOptions(dsn: string | undefined): SentryRuntimeOptions {
  const trimmed = dsn?.trim() || undefined;
  return {
    dsn: trimmed,
    enabled: Boolean(trimmed),
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: parseSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE),
    // Invoices carry client names, emails and addresses; don't attach request
    // bodies, cookies or IPs to events by default.
    sendDefaultPii: false,
  };
}
