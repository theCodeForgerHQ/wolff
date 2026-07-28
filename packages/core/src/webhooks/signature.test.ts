import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signWebhookPayload, verifyWebhookSignature, webhookHeaderNames } from './signature';

const secret = 'whsec_test';
const body = '{"id":"evt_1","type":"invoice.paid"}';
const at = new Date('2026-09-30T12:00:00Z');
const t = Math.floor(at.getTime() / 1000);

describe('outbound webhook signature', () => {
  it('signs `t.body` with HMAC-SHA256 and reports the timestamp it used', () => {
    const header = signWebhookPayload(secret, body, at);
    const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');

    expect(header).toBe(`t=${t},v1=${expected}`);
  });

  it('verifies its own signature inside the replay window', () => {
    const header = signWebhookPayload(secret, body, at);

    expect(verifyWebhookSignature(secret, body, header, new Date(at.getTime() + 299_000))).toBe(
      true
    );
  });

  it.each([
    [
      'a body that was changed',
      () => [secret, `${body} `, signWebhookPayload(secret, body, at), at],
    ],
    ['another secret', () => ['whsec_other', body, signWebhookPayload(secret, body, at), at]],
    [
      'a signature older than 5 minutes',
      () => [secret, body, signWebhookPayload(secret, body, at), new Date(at.getTime() + 301_000)],
    ],
    [
      'a timestamp from the future',
      () => [secret, body, signWebhookPayload(secret, body, at), new Date(at.getTime() - 301_000)],
    ],
    ['a header without a timestamp', () => [secret, body, 'v1=abc', at]],
    ['a header without a signature', () => [secret, body, `t=${t}`, at]],
    ['a non-numeric timestamp', () => [secret, body, 't=NaN,v1=abc', at]],
    ['a signature of another length', () => [secret, body, `t=${t},v1=abcd`, at]],
    ['an empty header', () => [secret, body, '', at]],
  ] as const)('rejects %s', (_name, build) => {
    const [s, b, header, now] = build() as unknown as [string, string, string, Date];

    expect(verifyWebhookSignature(s, b, header, now)).toBe(false);
  });

  it('names its headers after the product', () => {
    expect(webhookHeaderNames.signature).toMatch(/^X-[A-Z][a-z]+-Signature$/);
    expect(webhookHeaderNames.eventId).toMatch(/^X-[A-Z][a-z]+-Event-Id$/);
    expect(webhookHeaderNames.apiVersion).toMatch(/^X-[A-Z][a-z]+-Api-Version$/);
  });
});
