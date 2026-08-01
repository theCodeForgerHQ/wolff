import type { Response } from 'express';
import { ERROR_STATUS, type CursorMeta, type ErrorCode, type PageMeta } from '@wolff/contracts';

/** Response helpers for the envelope of the design. */
export function sendData(res: Response, data: unknown, status = 200, meta?: PageMeta | CursorMeta) {
  res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });
}

export function sendError(
  res: Response,
  code: ErrorCode,
  message: string,
  details?: Record<string, string[]>,
  status: number = ERROR_STATUS[code]
) {
  res
    .status(status)
    .json({ success: false, error: { code, message, ...(details ? { details } : {}) } });
}
