import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Db } from '@wolff/core/context';
import '../context';
import { sendError } from '../http';

/**
 * `Idempotency-Key` on POST. The first request with a key runs
 * and its response is stored for 24 hours; a repeat of the same request gets
 * the stored response and nothing runs twice. The key is scoped to the
 * workspace, and bound to the request it was first used with.
 */
const TTL_MS = 24 * 60 * 60 * 1000;
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
      if (existing && existing.expiresAt.getTime() <= Date.now()) {
        // The stored response has expired: the key is free again.
        await db.idempotencyKey.deleteMany({ where: { workspaceId, key, id: existing.id } });
        claimed = (await claim()).count === 1;
      } else if (existing && existing.requestHash !== requestHash) {
        return sendError(res, 'conflict', 'This Idempotency-Key was used with a different request');
      } else if (existing && existing.responseStatus !== null) {
        res.set(REPLAY_HEADER, 'true');
        res.status(existing.responseStatus).json(existing.responseBody);
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
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      const where = { workspaceId, key };
      const done =
        res.statusCode >= 500
          ? db.idempotencyKey.deleteMany({ where })
          : db.idempotencyKey.updateMany({
              where,
              data: { responseStatus: res.statusCode, responseBody: (body ?? null) as never },
            });
      done.then(
        () => json(body),
        (error) => next(error)
      );
      return res;
    };
    next();
  };
}
