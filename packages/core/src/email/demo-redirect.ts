/**
 * The free demo lets anyone press "send invoice". In demo mode every outgoing
 * email goes to one address the owner controls instead, so a visitor can
 * neither reach a real person nor hit the sending provider's recipient limits
 * (Resend's shared sender delivers only to the account's own address). The
 * intended recipients are kept, in the subject, so the message still shows
 * what would have been sent.
 */

const ADDRESS = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/**
 * The redirect address when DEMO_MODE is on, `undefined` when it is off.
 * Throws when demo mode is on without a single valid DEMO_EMAIL_REDIRECT, so a
 * process that would mail real people refuses to start.
 */
export function demoEmailRedirect(env: Record<string, string | undefined>): string | undefined {
  const mode = env.DEMO_MODE?.trim();
  if (mode === undefined || mode === '' || mode === 'false') return undefined;
  if (mode !== 'true')
    throw new Error(`DEMO_MODE must be "true" or "false", got ${JSON.stringify(mode)}`);
  const redirect = env.DEMO_EMAIL_REDIRECT?.trim() ?? '';
  if (!ADDRESS.test(redirect)) {
    throw new Error('DEMO_MODE=true requires DEMO_EMAIL_REDIRECT to be one email address');
  }
  return redirect;
}

interface Addressed {
  to: string | string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
}

const list = (value: string | string[] | undefined): string[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

/** The message's addressing, sent to `redirect` only; copies are dropped. */
export function redirectForDemo<T extends Addressed>(
  message: T,
  redirect: string
): Omit<T, 'to'> & { to: string[] } {
  const parts = [`to ${list(message.to).join(', ')}`];
  if (message.cc?.length) parts.push(`cc ${message.cc.join(', ')}`);
  if (message.bcc?.length) parts.push(`bcc ${message.bcc.join(', ')}`);
  return {
    ...message,
    to: [redirect],
    cc: undefined,
    bcc: undefined,
    subject: `[demo, ${parts.join(', ')}] ${message.subject}`,
  };
}
