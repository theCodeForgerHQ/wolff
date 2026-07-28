import type { ErrorCode } from '@wolff/contracts';

/**
 * An error a caller is expected to show to its user. The code is one of the
 * API's documented error codes, so the API can map it to a status directly.
 */
export class CoreError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, string[]>
  ) {
    super(message);
    this.name = 'CoreError';
  }
}
