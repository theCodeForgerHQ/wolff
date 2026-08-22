import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmailTransport } from './bootstrap';
import { loadConfig } from './config';

afterEach(() => vi.unstubAllGlobals());

describe('job email in demo mode', () => {
  it('reaches Resend addressed to the redirect only', async () => {
    const bodies: { to: string[]; subject: string }[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response('{}', { status: 200 });
    });
    const transport = createEmailTransport(
      loadConfig({
        RESEND_API_KEY: 're_test',
        EMAIL_FROM: 'Demo <demo@x.test>',
        DEMO_MODE: 'true',
        DEMO_EMAIL_REDIRECT: 'owner@x.test',
      })
    );

    await transport.send({
      to: 'client@acme.test',
      subject: 'Invoice INV-1',
      html: '<p>Pay</p>',
      idempotencyKey: 'job-1',
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.to).toEqual(['owner@x.test']);
    expect(bodies[0]!.subject).toBe('[demo, to client@acme.test] Invoice INV-1');
  });
});
