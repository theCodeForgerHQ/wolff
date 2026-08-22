import type { ErrorRequestHandler, RequestHandler } from 'express';
import { z } from 'zod';
import { CoreError } from '@wolff/core/errors';
import { InvalidCursorError } from '@wolff/core/pagination';
import type { Logger } from '@wolff/core/logger';
import { sendError } from '../http';

export const notFound: RequestHandler = (_req, res) => {
  sendError(res, 'not_found', 'Not found');
};

function zodDetails(error: z.ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  for (const issue of error.issues) {
    (details[issue.path.join('.') || '_'] ??= []).push(issue.message);
  }
  return details;
}

/**
 * The one place an error becomes a response. Errors the application raised on
 * purpose keep their message; anything else is logged and answered with a
 * bare 500, so internals never reach a client. It must stay the last
 * middleware: on Vercel an error that reaches Express's own handler can leave
 * the function in an undefined state.
 */
export function errorHandler(
  logger: Logger,
  report?: (error: unknown) => void | Promise<void>
): ErrorRequestHandler {
  return async (error, req, res, _next) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (error instanceof CoreError) {
      sendError(res, error.code, error.message, error.details);
      return;
    }
    if (error instanceof z.ZodError) {
      sendError(res, 'validation_error', 'Validation failed', zodDetails(error));
      return;
    }
    if (error instanceof InvalidCursorError) {
      sendError(res, 'validation_error', 'Invalid cursor', { cursor: ['Invalid cursor'] });
      return;
    }
    // Errors raised by the body parser carry a status and a type.
    const parser = error as { type?: string; status?: number };
    if (parser.type === 'entity.parse.failed') {
      sendError(res, 'validation_error', 'Request body is not valid JSON');
      return;
    }
    if (parser.type === 'entity.too.large') {
      sendError(res, 'validation_error', 'Request body is too large', undefined, 413);
      return;
    }

    logger.error({ err: error, method: req.method, path: req.path }, 'Unhandled error');
    // Awaited before answering: a serverless function is frozen once it
    // responds, which would strand the report. A failed report must not
    // cost the client its response.
    try {
      await report?.(error);
    } catch (reportError) {
      logger.error({ err: reportError }, 'Error report failed');
    }
    sendError(res, 'internal_error', 'An unexpected error occurred');
  };
}
