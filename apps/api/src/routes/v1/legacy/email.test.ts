import { describe, expect, it } from 'vitest';
import type { Store } from 'express-rate-limit';
import type { EmailMessage } from '@wolff/jobs';
import { documentEmailSender } from './email';

const email = { subject: 'Quote Q-0001', html: '<p>Hi</p>' };
const input = (version: string, extra: Partial<typeof email> = {}) => ({
  workspaceId: 'ws',
  recipients: ['one@example.test', 'two@example.test'],
  email: { ...email, ...extra },
  reference: 'quote:q1',
  version,
});

/**
 * Like Resend: a key it has seen returns the first result and sends
 * nothing. Fails the first attempt for one recipient.
 */
function providerFailingOnce(failFor: string) {
  const delivered: EmailMessage[] = [];
  const seen = new Set<string>();
  let failed = false;
  return {
    delivered,
    transport: {
      send: async (message: EmailMessage) => {
        if (seen.has(message.idempotencyKey)) return;
        if (message.to === failFor && !failed) {
          failed = true;
          throw new Error('provider unavailable');
        }
        seen.add(message.idempotencyKey);
        delivered.push(message);
      },
    },
  };
}

describe('document email sender', () => {
  it('does not email a recipient twice when a partial send is retried', async () => {
    const provider = providerFailingOnce('two@example.test');
    const send = documentEmailSender(provider.transport);

    expect(await send(input('v1'))).toEqual({ outcome: 'failed' });
    expect(await send(input('v1'))).toEqual({ outcome: 'sent' });

    expect(provider.delivered.map((m) => m.to)).toEqual(['one@example.test', 'two@example.test']);
  });

  it('sends again for a new version or a different email', async () => {
    const provider = providerFailingOnce('nobody');
    const send = documentEmailSender(provider.transport);

    await send(input('v1'));
    await send(input('v2'));
    await send(input('v2', { html: '<p>Hi again</p>' }));

    expect(provider.delivered).toHaveLength(6);
    expect(new Set(provider.delivered.map((m) => m.idempotencyKey)).size).toBe(6);
  });

  it('keeps addresses and content out of the idempotency key', async () => {
    const provider = providerFailingOnce('nobody');
    await documentEmailSender(provider.transport)(input('v1'));

    for (const { idempotencyKey } of provider.delivered) {
      expect(idempotencyKey).toMatch(/^quote:q1:[0-9a-f]{32}$/);
    }
  });

  it('gives the time left in the hour when the limit is reached', async () => {
    const store = {
      increment: async () => ({ totalHits: 21, resetTime: new Date(Date.now() + 125_000) }),
      decrement: async () => {},
      resetKey: async () => {},
    } as unknown as Store;
    const send = documentEmailSender({ send: async () => {} }, () => store);

    const result = await send(input('v1'));

    expect(result.outcome).toBe('limited');
    expect(result.outcome === 'limited' && result.retryAfterS).toBeGreaterThanOrEqual(124);
    expect(result.outcome === 'limited' && result.retryAfterS).toBeLessThanOrEqual(125);
  });
});
