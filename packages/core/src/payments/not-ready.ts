/**
 * Thrown while applying a provider event that cannot be applied *yet*: the
 * payment it names has no row, or a refund arrives before the payment was
 * credited. Providers do not promise delivery order, so the event is left
 * unprocessed and retried (processProviderEvent counts the attempt) instead
 * of being marked processed and lost. After MAX_PROCESSING_ATTEMPTS it is
 * dead-lettered and logged at error for someone to look at.
 */
export class ProviderEventNotReadyError extends Error {
  constructor(message: string) {
    super(`Provider event not ready: ${message}`);
    this.name = 'ProviderEventNotReadyError';
  }
}
