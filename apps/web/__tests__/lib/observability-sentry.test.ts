import { afterEach, describe, expect, it, vi } from 'vitest';
import { sentryOptions } from '@/lib/observability/sentry';

describe('sentryOptions', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([undefined, '', '   '])('keeps Sentry disabled when the DSN is %j', (dsn) => {
    const options = sentryOptions(dsn);
    expect(options.enabled).toBe(false);
    expect(options.dsn).toBeUndefined();
  });

  it('enables Sentry when a DSN is configured', () => {
    const options = sentryOptions('https://key@o1.ingest.sentry.io/1');
    expect(options.enabled).toBe(true);
    expect(options.dsn).toBe('https://key@o1.ingest.sentry.io/1');
  });

  it('never sends default PII', () => {
    expect(sentryOptions('https://key@o1.ingest.sentry.io/1').sendDefaultPii).toBe(false);
  });

  it('uses a valid SENTRY_TRACES_SAMPLE_RATE and falls back to 0.1 otherwise', () => {
    vi.stubEnv('SENTRY_TRACES_SAMPLE_RATE', '0.5');
    expect(sentryOptions(undefined).tracesSampleRate).toBe(0.5);
    vi.stubEnv('SENTRY_TRACES_SAMPLE_RATE', '7');
    expect(sentryOptions(undefined).tracesSampleRate).toBe(0.1);
  });
});
