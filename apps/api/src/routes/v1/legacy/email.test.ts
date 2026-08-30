import { describe, expect, it } from 'vitest';
import type { Store } from 'express-rate-limit';
import { documentEmailSender } from './email';

const email = { subject: 'Quote Q-0001', html: '<p>Hi</p>' };
const input = () => ({
  workspaceId: 'ws',
  recipients: ['one@example.test', 'two@example.test'],
  email,
  reference: 'quote:q1',
});

describe('document email sender', () => {
  it('gives the time left in the hour when the limit is reached', async () => {
    const store = {
      increment: async () => ({ totalHits: 21, resetTime: new Date(Date.now() + 125_000) }),
      decrement: async () => {},
      resetKey: async () => {},
    } as unknown as Store;
    const send = documentEmailSender({ send: async () => {} }, () => store);

    const result = await send(input());

    expect(result.outcome).toBe('limited');
    expect(result.outcome === 'limited' && result.retryAfterS).toBeGreaterThanOrEqual(124);
    expect(result.outcome === 'limited' && result.retryAfterS).toBeLessThanOrEqual(125);
  });
});
