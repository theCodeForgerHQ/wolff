import cors from 'cors';
import express, { Router, type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Db } from '@wolff/core/context';
import { logger as defaultLogger, REDACT_PATHS, type Logger } from '@wolff/core/logger';
import type { ApiConfig } from './config';
import { errorHandler, notFound } from './middleware/error';
import { MemoryReplayCache, type ReplayCache } from './middleware/service-jwt';
import { internalRoutes } from './routes/internal';

export interface AppDeps {
  db: Db;
  config: ApiConfig;
  logger?: Logger;
  /** Reports an unexpected error to the error tracker. */
  report?: (error: unknown) => void;
  /** Where used service-token ids are remembered. Redis when instances share traffic. */
  replayCache?: ReplayCache;
  /** Adds routes before the 404 handler. Used by tests. */
  extend?: (router: Router) => void;
}

const JSON_LIMIT = '1mb';

/**
 * Builds the Express app without starting it, so the same app serves the
 * long-running server (`server.ts`), the Vercel function (`index.ts`) and the
 * tests.
 */
export function createApp(deps: AppDeps): Express {
  const { db, config } = deps;
  const logger = deps.logger ?? defaultLogger;
  const app = express();

  app.disable('x-powered-by');
  // One proxy in front (ALB or Vercel): take the client IP from its header.
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(
    pinoHttp({
      logger,
      redact: REDACT_PATHS,
      autoLogging: config.NODE_ENV !== 'test',
    })
  );

  // Liveness: the process answers. Readiness: its dependencies answer.
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/readyz', async (_req, res) => {
    try {
      await db.$unscoped.$queryRaw`SELECT 1`;
      res.json({ status: 'ready', checks: { database: 'up' } });
    } catch (error) {
      logger.error({ err: error }, 'Readiness check failed');
      res.status(503).json({ status: 'unavailable', checks: { database: 'down' } });
    }
  });

  // Private routes are called by the web app's origin only. No wildcard.
  app.use(
    cors({
      origin: (origin, allow) => allow(null, origin === config.WEB_ORIGIN),
      credentials: true,
    })
  );
  app.use(express.json({ limit: JSON_LIMIT }));

  app.use('/internal', internalRoutes(config, deps.replayCache ?? new MemoryReplayCache()));

  const router = Router();
  deps.extend?.(router);
  app.use(router);

  app.use(notFound);
  app.use(errorHandler(logger, deps.report));
  return app;
}
