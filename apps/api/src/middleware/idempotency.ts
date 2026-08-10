import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Db } from '@wolff/core/context';
import '../context';
import { sendError } from '../http';

const MISSING_KEY_MESSAGE = 'Idempotency-Key header is required for this request';

/**
 * `Idempotency-Key` on POST. The first request with a key runs
 * and its response is stored for 24 hours; a repeat of the same request gets
 * the stored response and nothing runs twice. The key is scoped to the
 * workspace, and bound to the request it was first used with.
 */
const TTL_MS = 24 * 60 * 60 * 1000;
/**
 * How long a claimed key with no response yet blocks a retry. After that the
 * first request is presumed dead (process killed, connection lost before the
 * response was stored) and the key may be claimed again.
 */
export const LEASE_MS = 60_000;
const REDACTED = '[redacted: shown only in the first response]';

/**
 * Values that must not sit in the database for 24 hours in clear: the
 * webhook signing secret is returned once, on creation. A replay gets the
 * placeholder instead.
 */
function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        k === 'secret' && typeof v === 'string' ? REDACTED : redactSecrets(v),
      ])
    );
  }
  return value;
}
const MAX_KEY_LENGTH = 255;
export const REPLAY_HEADER = 'Idempotent-Replayed';

export function idempotency(db: Db): RequestHandler {
  return async (req, res, next) => {
    const key = req.get('idempotency-key');
    if (req.method !== 'POST' || key === undefined) return next();
    const workspaceId = req.ctx?.workspaceId;
    if (!workspaceId) return next(new Error('idempotency must run after authentication'));

    if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
      const message = `Idempotency-Key must be 1 to ${MAX_KEY_LENGTH} characters`;
      return sendError(res, 'validation_error', message, { 'Idempotency-Key': [message] });
    }

    const path = req.originalUrl.split('?')[0]!;
    const requestHash = createHash('sha256')
      .update(`${req.method}\n${path}\n${JSON.stringify(req.body ?? null)}`)
      .digest('hex');

    const claim = () =>
      db.idempotencyKey.createMany({
        data: {
          workspaceId,
          key,
          method: req.method,
          path: path.slice(0, 500),
          requestHash,
          expiresAt: new Date(Date.now() + TTL_MS),
        },
        skipDuplicates: true,
      });

    let claimed = (await claim()).count === 1;
    if (!claimed) {
      const existing = await db.idempotencyKey.findFirst({ where: { workspaceId, key } });
      const abandoned =
        existing !== null &&
        existing.responseStatus === null &&
        existing.createdAt.getTime() + LEASE_MS <= Date.now();
      if (existing && (existing.expiresAt.getTime() <= Date.now() || abandoned)) {
        // The stored response has expired, or the first request never
        // answered within its lease: the key is free again.
        await db.idempotencyKey.deleteMany({ where: { workspaceId, key, id: existing.id } });
        claimed = (await claim()).count === 1;
      } else if (existing && existing.requestHash !== requestHash) {
        return sendError(res, 'conflict', 'This Idempotency-Key was used with a different request');
      } else if (existing && existing.responseStatus !== null) {
        res.set(REPLAY_HEADER, 'true');
        res.status(existing.responseStatus);
        if (existing.responseBody === null) res.end();
        else res.json(existing.responseBody);
        return;
      }
      if (!claimed) {
        // Same request, no response yet: the first one is still running.
        return sendError(
          res,
          'conflict',
          'A request with this Idempotency-Key is still in progress'
        );
      }
    }

    // Store what the handler answers. A 5xx is not stored: the request did
    // not complete, and the client must be able to retry with the same key.
    const where = { workspaceId, key };
    const record = (status: number, body: unknown) =>
      status >= 500
        ? db.idempotencyKey.deleteMany({ where })
        : db.idempotencyKey.updateMany({
            where,
            data: { responseStatus: status, responseBody: (body ?? null) as never },
          });
    let settled = false;

    // JSON answers are stored before they are sent, so a retry that arrives
    // right after the response replays it.
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      settled = true;
      // As it goes over the wire (dates become strings), then redacted.
      const stored = body === undefined ? null : redactSecrets(JSON.parse(JSON.stringify(body)));
      record(res.statusCode, stored).then(
        () => json(body),
        (error) => next(error)
      );
      return res;
    };
    // Any other answer (res.send, res.end, a 204) is stored with its status
    // (not its body) before it goes out. res.json ends here too, already
    // recorded.
    const end = res.end.bind(res) as (...args: unknown[]) => typeof res;
    res.end = ((...args: unknown[]) => {
      if (settled) return end(...args);
      settled = true;
      record(res.statusCode, null).then(
        () => end(...args),
        (error) => next(error)
      );
      return res;
    }) as typeof res.end;
    // The connection closed before an answer was sent: free the key now
    // rather than after the lease.
    res.on('close', () => {
      if (settled || res.writableFinished) return;
      settled = true;
      db.idempotencyKey.deleteMany({ where: { ...where, responseStatus: null } }).catch(() => {});
    });
    next();
  };
}

/**
 * Enforces that money-affecting POSTs carry an `Idempotency-Key` header.
 * Mount this *before* the global `idempotency()` middleware on the route
 * so the key is present when the global middleware runs.
 */
export function requireIdempotencyKey(): RequestHandler {
  return (req, res, next) => {
    if (req.method !== 'POST') return next();
    const key = req.get('idempotency-key');
    if (key === undefined || key.length === 0) {
      return sendError(res, 'validation_error', MISSING_KEY_MESSAGE, {
        'Idempotency-Key': [MISSING_KEY_MESSAGE],
      });
    }
    next();
  };
}
