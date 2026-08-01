import type { EmailTransport } from '../types';

/** No line breaks or other control characters in a header value. */
function headerSafe(value: string): string {
  return [...value.replace(/[\r\n]+/g, ' ')]
    .filter((char) => char.charCodeAt(0) >= 0x20 && char.charCodeAt(0) !== 0x7f)
    .join('')
    .trim();
}

/**
 * Sends through Resend's HTTP API. The job's idempotency key goes in the
 * `Idempotency-Key` header, so a job that is retried after the email was
 * already accepted does not send it twice.
 */
export function createResendTransport(options: {
  apiKey: string;
  from: string;
  /** Overridden in tests. */
  baseUrl?: string;
}): EmailTransport {
  const url = `${(options.baseUrl ?? 'https://api.resend.com').replace(/\/$/, '')}/emails`;

  return {
    async send(message) {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': message.idempotencyKey,
        },
        body: JSON.stringify({
          from: options.from,
          to: [message.to],
          subject: headerSafe(message.subject),
          html: message.html,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      // The response body can echo the recipient; only the status is reported.
      if (!response.ok) throw new Error(`Resend answered ${response.status}`);
    },
  };
}

/**
 * For development without an email account: nothing is sent, and what would
 * have been is reported without the recipient or the body.
 */
export function createLogEmailTransport(
  log: (entry: { subject: string; idempotencyKey: string }) => void
): EmailTransport {
  return {
    async send(message) {
      log({ subject: message.subject, idempotencyKey: message.idempotencyKey });
    },
  };
}
