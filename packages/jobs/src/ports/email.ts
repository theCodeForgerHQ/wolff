import { redirectForDemo } from '@wolff/core/email';
import type { EmailTransport } from '../types';

/** No line breaks or other control characters in a header value. */
function headerSafe(value: string): string {
  return [...value.replace(/[\r\n]+/g, ' ')]
    .filter((char) => char.charCodeAt(0) >= 0x20 && char.charCodeAt(0) !== 0x7f)
    .join('')
    .trim();
}

/** Waits before asking again while another request sends with the same key. */
const IN_FLIGHT_RETRY_DELAYS_MS = [250, 500, 1000, 2000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resend's 409 for "a request with this key is still being processed". */
async function isKeyInFlight(response: Response): Promise<boolean> {
  if (response.status !== 409) return false;
  const body = (await response.json().catch(() => null)) as { name?: unknown } | null;
  return body?.name === 'concurrent_idempotent_requests';
}

/**
 * Sends through Resend's HTTP API. The job's idempotency key goes in the
 * `Idempotency-Key` header, so a job that is retried after the email was
 * already accepted does not send it twice.
 *
 * Two requests with the same key at the same time (two clicks on Send):
 * Resend answers the second 409 `concurrent_idempotent_requests` while the
 * first is still running, and replays the first one's result after. So
 * the second waits and asks again with the same key, and ends as the first
 * did, without a second email. Any other 409 (the key reused with a
 * different message) fails at once.
 */
export function createResendTransport(options: {
  apiKey: string;
  from: string;
  /** Overridden in tests. */
  baseUrl?: string;
  /** Overridden in tests. */
  inFlightRetryDelaysMs?: readonly number[];
}): EmailTransport {
  const url = `${(options.baseUrl ?? 'https://api.resend.com').replace(/\/$/, '')}/emails`;
  const delays = options.inFlightRetryDelaysMs ?? IN_FLIGHT_RETRY_DELAYS_MS;

  return {
    async send(message) {
      const body = JSON.stringify({
        from: options.from,
        to: [message.to],
        subject: headerSafe(message.subject),
        html: message.html,
      });
      for (let attempt = 0; ; attempt += 1) {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': message.idempotencyKey,
          },
          body,
          signal: AbortSignal.timeout(15_000),
        });
        if (response.ok) return;
        const delay = delays[attempt];
        if (delay !== undefined && (await isKeyInFlight(response))) {
          await sleep(delay);
          continue;
        }
        // The response body can echo the recipient; only the status is reported.
        throw new Error(`Resend answered ${response.status}`);
      }
    },
  };
}

/**
 * For development without an email account: nothing is sent. What would have
 * been is reported by job key and counts only: no address, no subject (it
 * names clients, and in demo mode the intended recipients), no body.
 */
export function createLogEmailTransport(
  log: (entry: { idempotencyKey: string; recipientCount: number; redirected: boolean }) => void
): EmailTransport {
  return {
    async send(message) {
      log({
        idempotencyKey: message.idempotencyKey,
        recipientCount: 1,
        redirected: message.redirected === true,
      });
    },
  };
}

/**
 * The free demo's guard (DEMO_MODE): every email goes to `redirect`, with
 * the intended recipient in the subject. Wraps whichever transport is set up.
 */
export function withDemoRedirect(inner: EmailTransport, redirect: string): EmailTransport {
  return {
    async send(message) {
      const { to, subject } = redirectForDemo(message, redirect);
      await inner.send({ ...message, to: to[0] ?? redirect, subject, redirected: true });
    },
  };
}
