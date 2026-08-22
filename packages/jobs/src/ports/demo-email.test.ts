import { describe, expect, it } from 'vitest';
import type { EmailMessage } from '../types';
import { createLogEmailTransport, withDemoRedirect } from './email';

describe('demo email redirect', () => {
  it('sends every job email to the redirect, naming the intended recipient', async () => {
    const sent: EmailMessage[] = [];
    const transport = withDemoRedirect({ send: async (m) => void sent.push(m) }, 'owner@x.test');

    await transport.send({
      to: 'client@acme.test',
      subject: 'Invoice INV-1',
      html: '<p>Pay</p>',
      idempotencyKey: 'job-1',
    });

    expect(sent).toEqual([
      {
        to: 'owner@x.test',
        subject: '[demo, to client@acme.test] Invoice INV-1',
        html: '<p>Pay</p>',
        idempotencyKey: 'job-1',
        redirected: true,
      },
    ]);
  });

  it('logs no address and no subject text for a redirected send', async () => {
    const logged: unknown[] = [];
    const transport = withDemoRedirect(
      createLogEmailTransport((entry) => logged.push(entry)),
      'owner@x.test'
    );

    await transport.send({
      to: 'client@acme.test',
      subject: 'Invoice for Asha Rao',
      html: '<p>Pay</p>',
      idempotencyKey: 'job-1',
    });

    const text = JSON.stringify(logged);
    expect(text).not.toContain('@');
    expect(text).not.toMatch(/Invoice|Asha|Pay/);
    expect(logged).toEqual([{ idempotencyKey: 'job-1', recipientCount: 1, redirected: true }]);
  });
});
