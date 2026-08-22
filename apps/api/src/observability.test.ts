import { createTransport } from '@sentry/node';
import { afterAll, describe, expect, it } from 'vitest';
import { initObservability, shutdownObservability } from './observability';
import { testConfig } from './testing/harness';

afterAll(() => shutdownObservability());

describe('error reporting', () => {
  it('resolves only after the event has left the process', async () => {
    // On Vercel the function is frozen once the response is sent, so an
    // event still queued in the SDK at that point is never delivered.
    const delivered: string[] = [];
    const transport = (options: Parameters<typeof createTransport>[0]) =>
      createTransport(options, async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        delivered.push(String(request.body));
        return { statusCode: 200 };
      });
    const { report } = initObservability(
      { ...testConfig(), SENTRY_DSN: 'https://key@o0.ingest.sentry.io/1' },
      { transport }
    );

    await report(new Error('reported before the function returns'));

    expect(delivered.join('')).toContain('reported before the function returns');
  });
});
