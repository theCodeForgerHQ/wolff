import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sent: Array<Record<string, unknown>> = [];
const logged: unknown[] = [];
let resendError: { name: string; message: string } | null = null;

vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async (message: Record<string, unknown>) => {
        sent.push(message);
        return resendError
          ? { data: null, error: resendError }
          : { data: { id: 'email_1' }, error: null };
      },
    };
  },
}));
vi.mock('@/lib/logger', () => {
  const record = (...args: unknown[]) => void logged.push(args);
  return { logger: { info: record, warn: record, error: record, debug: record } };
});
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: async () => ({ limited: false }) }));

import { sendEmail } from '@/lib/services/email';

describe('sendEmail in demo mode', () => {
  beforeEach(() => {
    sent.length = 0;
    logged.length = 0;
    resendError = null;
    vi.stubEnv('RESEND_API_KEY', 're_test');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('delivers only to the redirect, with the intended recipients in the subject', async () => {
    vi.stubEnv('DEMO_MODE', 'true');
    vi.stubEnv('DEMO_EMAIL_REDIRECT', 'owner@x.test');

    const result = await sendEmail({
      to: ['client@acme.test'],
      cc: ['cc@acme.test'],
      bcc: ['bcc@acme.test'],
      subject: 'Invoice INV-1',
      html: '<p>Pay</p>',
    });

    expect(result.success).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: ['owner@x.test'],
      cc: undefined,
      bcc: undefined,
      subject: '[demo, to client@acme.test, cc cc@acme.test, bcc bcc@acme.test] Invoice INV-1',
    });
  });

  it('sends as addressed outside demo mode', async () => {
    await sendEmail({ to: 'client@acme.test', subject: 'Invoice INV-1', html: '<p>Pay</p>' });

    expect(sent[0]).toMatchObject({ to: ['client@acme.test'], subject: 'Invoice INV-1' });
  });

  it('refuses to send in demo mode without a redirect', async () => {
    vi.stubEnv('DEMO_MODE', 'true');

    const result = await sendEmail({ to: 'client@acme.test', subject: 'x', html: 'x' });

    expect(result.success).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('logs no address and no subject text, even when Resend echoes one', async () => {
    vi.stubEnv('DEMO_MODE', 'true');
    vi.stubEnv('DEMO_EMAIL_REDIRECT', 'owner@x.test');
    const message = { to: 'client@acme.test', subject: 'Invoice for Asha Rao', html: '<p>Pay</p>' };

    await sendEmail(message);
    resendError = {
      name: 'validation_error',
      message: 'You can only send testing emails to your own address (owner@x.test).',
    };
    await sendEmail(message);

    const text = JSON.stringify(logged);
    expect(logged.length).toBeGreaterThan(0);
    expect(text).not.toContain('@');
    expect(text).not.toMatch(/Invoice|Asha|Pay/);
    expect(text).toContain('"redirected":true');
  });

  it('keeps every link in the plain-text version, next to its label', async () => {
    await sendEmail({
      to: 'client@acme.test',
      subject: 'Quote Q-1',
      html: `<p>Hi Asha,</p>
        <a href="https://app.test/q/tok123" style="color: white">
          View Quote
        </a>
        <p>Or <a href="https://app.test/help">get help</a>.</p>`,
    });

    const text = String(sent[0]!.text);
    expect(text).toContain('View Quote: https://app.test/q/tok123');
    expect(text).toContain('get help: https://app.test/help');
    expect(text).not.toContain('<');
  });
});
