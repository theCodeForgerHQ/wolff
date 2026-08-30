import * as Sentry from '@sentry/node';
import { createTransport } from '@sentry/node';
import { register } from '@prometheus-io/client';
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

  // The Sentry client installed here replaces the first test's.
  const delivered: string[] = [];
  let report: (error: unknown) => Promise<void>;
  const capture = () => {
    delivered.length = 0;
    if (!report) {
      // initObservability registers the process metrics again.
      register.clear();
      const transport = (options: Parameters<typeof createTransport>[0]) =>
        createTransport(options, async (request) => {
          delivered.push(String(request.body));
          return { statusCode: 200 };
        });
      ({ report } = initObservability(
        { ...testConfig(), SENTRY_DSN: 'https://key@o0.ingest.sentry.io/1' },
        { transport }
      ));
    }
    return { report, delivered };
  };

  // Prisma puts the whole query, values included, in its message.
  it('sends only the class, model and operation of a Prisma error', async () => {
    const { report, delivered } = capture();
    const error = Object.assign(
      new Error(
        '\nInvalid `prisma.client.findFirst()` invocation in\n/var/task/index.mjs:1:2\n\n' +
          '  where: { email: "priya@kaveri.test", name: "Priya Raman", total: 13378.84 }\n' +
          'Argument `id`: Invalid value provided. Expected String, provided Object.'
      ),
      { name: 'PrismaClientValidationError' }
    );

    await report(error);

    const sent = delivered.join('');
    expect(sent).toContain('PrismaClientValidationError');
    expect(sent).toContain('client.findFirst');
    for (const value of ['priya@kaveri.test', 'Priya Raman', '13378.84', 'Expected String']) {
      expect(sent).not.toContain(value);
    }
  });

  it('drops request bodies, cookies and credentials from every event', async () => {
    const { delivered } = capture();
    Sentry.captureEvent({
      message: 'with a request',
      request: {
        url: 'https://api.example.test/v1/clients?token=query-secret',
        data: '{"email":"body-secret@kaveri.test"}',
        cookies: { session: 'cookie-secret' },
        query_string: 'token=query-secret',
        headers: { cookie: 'session=cookie-secret', authorization: 'Bearer key-secret' },
      },
    });
    await Sentry.flush(2000);

    const sent = delivered.join('');
    expect(sent).toContain('with a request');
    for (const value of ['body-secret', 'cookie-secret', 'key-secret', 'query-secret']) {
      expect(sent).not.toContain(value);
    }
  });
});
