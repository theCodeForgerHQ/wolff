import type { RequestHandler } from 'express';
import { sendError } from '../http';

function hasNul(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('\u0000');
  if (Array.isArray(value)) return value.some(hasNul);
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, v]) => key.includes('\u0000') || hasNul(v));
  }
  return false;
}

function parsedOrRaw(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Postgres text cannot hold U+0000, so a body or query with one ended in a
 * 500 from the driver (found by Schemathesis on several routes). It is
 * refused up front for every route: 400 with the standard envelope.
 */
export const rejectNulCharacters: RequestHandler = (req, res, next) => {
  // The routes ported from Next receive their body as JSON text.
  const body = typeof req.body === 'string' ? parsedOrRaw(req.body) : req.body;
  if (hasNul(body) || hasNul(req.query)) {
    sendError(res, 'validation_error', 'Text may not contain the NUL character (U+0000)');
    return;
  }
  next();
};
