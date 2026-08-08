import { apiReference } from '@scalar/express-api-reference';
import cors from 'cors';
import express, { Router, type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Db } from '@wolff/core/context';
import { logger as defaultLogger, REDACT_PATHS, type Logger } from '@wolff/core/logger';
import type { ApiConfig } from './config';
import type { Store } from 'express-rate-limit';
import { apiKeyRateLimit, requireApiKey } from './middleware/auth';
import { errorHandler, notFound } from './middleware/error';
import { idempotency } from './middleware/idempotency';
import { MemoryReplayCache, type ReplayCache } from './middleware/service-jwt';
import { metricsHandler } from './observability';
import { generateOpenAPIDocument } from './openapi/document';
import { internalRoutes } from './routes/internal';
import { jobRoutes, type JobRunDeps } from './routes/jobs';
import { dealRoutes } from './routes/v1/deals';
import { invoiceRoutes } from './routes/v1/invoices';
import { leadRoutes } from './routes/v1/leads';
import { pipelineRoutes } from './routes/v1/pipelines';
import { publicRoutes } from './routes/v1/public';
import { reportRoutes } from './routes/v1/reports';
import { webhookEndpointRoutes } from './routes/v1/webhook-endpoints';
import { webhookRoutes } from './webhooks';
import type { PaymentProviderClients } from './payments/provider';

export interface AppDeps {
  db: Db;
  config: ApiConfig;
  logger?: Logger;
  /** Reports an unexpected error to the error tracker. */
  report?: (error: unknown) => void;
  /** Where used service-token ids are remembered. Redis when instances share traffic. */
  replayCache?: ReplayCache;
  /** Enables `/jobs/run/:type`. Absent: the route refuses every request. */
  jobs?: JobRunDeps;
  /** Told about outbox events a request wrote, once it committed (push dispatch). */
  onOutboxEvents?: (ids: string[]) => void;
  /** Rate-limit counters. Redis when instances share traffic; per process otherwise. */
  rateLimitStore?: Store;
  /** Injected Stripe/Razorpay clients for tests. Defaults to env-configured clients. */
  paymentClients?: PaymentProviderClients;
  /** Public app URL used to build checkout success/cancel URLs. */
  appUrl?: string;
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

  // Public API documentation. No authentication required.
  app.get('/openapi.json', (_req, res) => {
    res.json(generateOpenAPIDocument({ serverUrl: config.PUBLIC_API_URL }));
  });
  app.use(
    '/docs',
    apiReference({
      url: '/openapi.json',
      pageTitle: 'Wolff API Reference',
    })
  );
  app.get('/metrics', metricsHandler);

  // Provider webhooks: mounted before the JSON parser because their
  // signatures cover the raw body, and before CORS because no browser calls them.
  app.use('/webhooks', webhookRoutes({ db, config, onOutboxEvents: deps.onOutboxEvents }));

  app.use('/jobs', jobRoutes(config, deps.jobs));

  // Public widget routes: CORS reflects the caller's Origin when a valid
  // publishable key is presented; credentials are never used.
  app.use('/v1/public', express.json({ limit: JSON_LIMIT }));
  app.use(
    '/v1/public',
    cors({
      origin: (origin, allow) => allow(null, origin ?? false),
      credentials: false,
    })
  );
  app.use('/v1/public', publicRoutes({ db, rateLimitStore: deps.rateLimitStore }));

  // Private routes are called by the web app's origin only. No wildcard.
  app.use(
    cors({
      origin: (origin, allow) => allow(null, origin === config.WEB_ORIGIN),
      credentials: true,
    })
  );
  app.use(express.json({ limit: JSON_LIMIT }));

  app.use('/internal', internalRoutes(config, deps.replayCache ?? new MemoryReplayCache()));

  // The public API. Every route acts in the workspace of the key it was
  // called with; nothing below reads a workspace from the request itself.
  const v1 = Router();
  v1.use(requireApiKey(db), apiKeyRateLimit(deps.rateLimitStore), idempotency(db));
  v1.use(
    webhookEndpointRoutes(db, {
      // http is tolerated outside production so a local receiver can be used.
      requireHttps: config.NODE_ENV !== 'development',
    })
  );
  v1.use(leadRoutes(db));
  v1.use(pipelineRoutes(db));
  v1.use(dealRoutes(db));
  v1.use(invoiceRoutes(db, { paymentClients: deps.paymentClients, appUrl: config.APP_URL }));
  v1.use(reportRoutes(db));

  const router = Router();
  deps.extend?.(router);
  app.use(router);
  app.use('/v1', v1);

  app.use(notFound);
  app.use(errorHandler(logger, deps.report));
  return app;
}
