import { randomUUID } from 'node:crypto';
import { MemoryStore, type Store } from 'express-rate-limit';
import type { RenderedEmail } from '@wolff/core/email';
import { logger } from '@wolff/core/logger';
import type { EmailTransport } from '@wolff/jobs';
import type { RateLimitStoreFactory } from '../../../middleware/auth';

/** As the web app: at most 20 emails an hour per workspace. */
const EMAILS_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;

export type DocumentEmailSender = (input: {
  workspaceId: string;
  recipients: string[];
  email: RenderedEmail;
  /** For the provider's idempotency key and the logs: `quote:<id>`. */
  reference: string;
}) => Promise<EmailResult>;

/**
 * `sent`; `limited` (workspace over its hourly limit, with the seconds until
 * the hour's window resets); `failed` (not configured, provider error).
 */
export type EmailResult =
  { outcome: 'sent' } | { outcome: 'failed' } | { outcome: 'limited'; retryAfterS: number };

/**
 * Sends a quote or invoice email while the request waits, and says whether
 * it went out. The send routes change the document's status only when it
 * did, as the Next routes did. Over the hourly limit the route answers 429;
 * nothing configured or a provider failure, 502.
 * Logs carry the reference and counts, never an address or a subject.
 */
export function documentEmailSender(
  transport: EmailTransport | undefined,
  createStore?: RateLimitStoreFactory
): DocumentEmailSender {
  const store: Store = createStore?.('rl:email:') ?? new MemoryStore();
  store.init?.({ windowMs: HOUR_MS } as never);

  return async ({ workspaceId, recipients, email, reference }) => {
    if (!transport) {
      logger.warn({ reference }, 'Email transport not configured; document email not sent');
      return { outcome: 'failed' };
    }
    const { totalHits, resetTime } = await store.increment(workspaceId);
    if (totalHits > EMAILS_PER_HOUR) {
      logger.warn({ reference }, 'Email rate limit reached for the workspace');
      // The store's own reset time; a store without one means a full window.
      const left = resetTime ? resetTime.getTime() - Date.now() : HOUR_MS;
      return { outcome: 'limited', retryAfterS: Math.max(1, Math.ceil(left / 1000)) };
    }
    const attempt = randomUUID();
    try {
      for (const [index, to] of recipients.entries()) {
        await transport.send({
          to,
          subject: email.subject,
          html: email.html,
          idempotencyKey: `${reference}:${attempt}:${index}`,
        });
      }
      return { outcome: 'sent' };
    } catch (error) {
      logger.error(
        { reference, recipientCount: recipients.length, errorName: (error as Error)?.name },
        'Document email failed'
      );
      return { outcome: 'failed' };
    }
  };
}

export const EMAIL_LIMIT_MESSAGE = 'Email limit reached for this workspace. Try again later.';
