import type { Request, Response } from 'express';

/**
 * The response shapes of the `/v1` routes ported from Next in
 * Phase 6b. They keep the contract existing clients already parse, which is
 * not the `{ success, data }` envelope of the newer routes: a success is the
 * bare resource (lists: `{ data, pagination }`), an error is
 * `{ error: "<message>" }`. The recorded-response parity test holds them to
 * the Next routes byte for byte. Only what the shared middleware answers
 * (401, 403 for a missing scope, 429, 409 on an Idempotency-Key conflict)
 * uses the standard envelope.
 */
export function legacyJson(res: Response, body: unknown, status = 200): void {
  res.status(status).json(body);
}

export function legacyError(res: Response, message: string, status = 400): void {
  res.status(status).json({ error: message });
}

/** Paths whose body is read as text and parsed by the route (see `readJsonBody`). */
const LEGACY_PATH =
  /^\/v1\/(clients(\/import|\/[^/]+)?|quotes(\/[^/]+(\/send|\/duplicate)?)?|invoices(\/from-quote\/[^/]+|\/[^/]+(\/send)?)?)\/?$/;

export function isLegacyPath(path: string): boolean {
  return LEGACY_PATH.test(path);
}

/** No body, or a body that is not JSON. */
export const INVALID_JSON = Symbol('invalid-json');

/**
 * The request body as the Next routes read it (`await request.json()`): JSON
 * whatever the Content-Type, and a failure when the body is missing or not
 * valid JSON. The app reads these paths as text so that this route, not the
 * shared parser, decides (and after authentication, as before).
 */
export function readJsonBody(req: Request): unknown {
  if (typeof req.body !== 'string') return INVALID_JSON;
  try {
    return JSON.parse(req.body) as unknown;
  } catch {
    return INVALID_JSON;
  }
}

/** `readJsonBody` for the routes that treat a missing or broken body as `{}`. */
export function readOptionalJsonBody(req: Request): Record<string, unknown> {
  return asObject(readJsonBody(req));
}

/**
 * A parsed body as an object to read fields from. The Next routes destructure
 * whatever JSON arrived, so an array or a string simply has none of the
 * fields; `null` made them throw (500) and is treated the same way here.
 */
export function asObject(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

/** A Prisma Decimal, number or null as a number, as the Next routes' `toNumber`. */
export function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && 'toNumber' in value) {
    return (value as { toNumber: () => number }).toNumber();
  }
  return Number(value) || 0;
}

/** `?page=&limit=` exactly as the Next list routes parse them. */
export function pageParams(req: Request): { page: number; limit: number } {
  const query = (name: string) => queryParam(req, name) ?? null;
  // A value that is not a number falls back to the default. The Next routes
  // passed NaN on to Prisma and answered 500 (found by Schemathesis).
  const int = (name: string, fallback: number) => {
    const value = parseInt(query(name) || String(fallback), 10);
    return Number.isNaN(value) ? fallback : value;
  };
  const page = Math.max(1, int('page', 1));
  const limit = Math.min(100, Math.max(1, int('limit', 25)));
  return { page, limit };
}

/** A query parameter, or undefined when absent or empty (`searchParams.get(x) || undefined`). */
export function queryParam(req: Request, name: string): string | undefined {
  const raw = req.query[name];
  // `searchParams.get` returns the first of repeated parameters.
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Fields a client may never set on a resource; the Next routes drop them. */
export function stripProtectedFields(body: unknown, extra: string[] = []): Record<string, unknown> {
  const blocked = new Set(['id', 'workspaceId', 'deletedAt', 'createdAt', 'updatedAt', ...extra]);
  return Object.fromEntries(Object.entries(asObject(body)).filter(([key]) => !blocked.has(key)));
}

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A route parameter (`:id`) as a string. */
export function param(req: Request, name: string): string {
  return String(req.params[name] ?? '');
}

/** `recipients` when given: a list of strings, else the route answers 400. */
export function badRecipients(recipients: unknown): boolean {
  return (
    Boolean(recipients) &&
    (!Array.isArray(recipients) || recipients.some((value) => typeof value !== 'string'))
  );
}

export const BAD_RECIPIENTS = 'recipients must be a list of email addresses';

/** Postgres refused a duplicate (Prisma P2002). */
export function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'P2002';
}
