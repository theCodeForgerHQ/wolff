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
}) => Promise<EmailOutcome>;

/** `sent`; `limited` (workspace over its hourly limit); `failed` (not configured, provider error). */
export type EmailOutcome = 'sent' | 'limited' | 'failed';

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
      return 'failed';
    }
    const { totalHits } = await store.increment(workspaceId);
    if (totalHits > EMAILS_PER_HOUR) {
      logger.warn({ reference }, 'Email rate limit reached for the workspace');
      return 'limited';
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
      return 'sent';
    } catch (error) {
      logger.error(
        { reference, recipientCount: recipients.length, errorName: (error as Error)?.name },
        'Document email failed'
      );
      return 'failed';
    }
  };
}

export const EMAIL_LIMIT_MESSAGE = 'Email limit reached for this workspace. Try again later.';
export const EMAIL_LIMIT_RETRY_AFTER_S = HOUR_MS / 1000;
