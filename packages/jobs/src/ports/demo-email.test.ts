import { describe, expect, it } from 'vitest';
import type { EmailMessage } from '../types';
import { withDemoRedirect } from './email';

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
      },
    ]);
  });
});
