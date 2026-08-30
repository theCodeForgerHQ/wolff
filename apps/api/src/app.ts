import { apiReference } from '@scalar/express-api-reference';
import cors from 'cors';
import express, { Router, type Express } from 'express';
import helmet from 'helmet';
import type { Db } from '@wolff/core/context';
import { isPublishableKeyOrigin } from '@wolff/core/auth/api-keys';
import { logger as defaultLogger, type Logger } from '@wolff/core/logger';
import type { ApiConfig } from './config';
import {
  apiKeyRateLimit,
  authFailureRateLimit,
  requireApiKey,
  type RateLimitStoreFactory,
} from './middleware/auth';
import { errorHandler, notFound } from './middleware/error';
import { rejectNulCharacters } from './middleware/nul';
import { idempotency } from './middleware/idempotency';
import { cachedOriginCheck } from './middleware/origin-cache';
import { requestLogger } from './middleware/request-log';
import { MemoryReplayCache, type ReplayCache } from './middleware/service-jwt';
import { generateOpenAPIDocument } from './openapi/document';
import { internalRoutes } from './routes/internal';
import { jobRoutes, type JobRunDeps } from './routes/jobs';
import { dealRoutes } from './routes/v1/deals';
import { invoiceRoutes } from './routes/v1/invoices';
import { leadRoutes } from './routes/v1/leads';
import { pipelineRoutes } from './routes/v1/pipelines';
import { publicRoutes } from './routes/v1/public';
import { reportRoutes } from './routes/v1/reports';
import { automationRoutes } from './routes/v1/automations';
import { isLegacyPath } from './routes/v1/legacy/http';
import { legacyV1Routes } from './routes/v1/legacy';
import { webhookEndpointRoutes } from './routes/v1/webhook-endpoints';
import { webhookRoutes } from './webhooks';
import type { PaymentProviderClients } from './payments/provider';
import type { EmailTransport } from '@wolff/jobs';
import type { RequestListener } from 'node:http';

export interface AppDeps {
  db: Db;
  config: ApiConfig;
  logger?: Logger;
  /** Reports an unexpected error to the error tracker; resolves once it is sent. */
  report?: (error: unknown) => void | Promise<void>;
  /** Where used service-token ids are remembered. Redis when instances share traffic. */
  replayCache?: ReplayCache;
  /** Enables `/jobs/run/:type`. Absent: the route refuses every request. */
  jobs?: JobRunDeps;
  /** Told about outbox events a request wrote, once it committed (push dispatch). */
  onOutboxEvents?: (ids: string[]) => void | Promise<void>;
  /** Rate-limit counters. Redis when instances share traffic; per process otherwise. */
  rateLimitStore?: RateLimitStoreFactory;
  /** Injected Stripe/Razorpay clients for tests. Defaults to env-configured clients. */
  paymentClients?: PaymentProviderClients;
  /** Public app URL used to build checkout success/cancel URLs. */
  appUrl?: string;
  /**
   * Sends the emails of `POST /v1/quotes/:id/send` and `/v1/invoices/:id/send`
   * while the request waits, as the Next routes did. Absent: those routes
   * answer 502 and change nothing, as the Next routes did without Resend.
   */
  email?: EmailTransport;
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
  app.use(requestLogger(logger, { autoLogging: config.NODE_ENV !== 'test' }));

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

  // Provider webhooks: mounted before the JSON parser because their
  // signatures cover the raw body, and before CORS because no browser calls them.
  app.use('/webhooks', webhookRoutes({ db, config, onOutboxEvents: deps.onOutboxEvents }));

  app.use('/jobs', jobRoutes(config, deps.jobs));

  // Public widget routes: CORS (preflight included) answers only an origin
  // that some live publishable key allows; the request itself is then held
  // to its own key's origins (requirePublishableKey). No credentials.
  app.use('/v1/public', express.json({ limit: JSON_LIMIT }));
  const publicOrigin = cachedOriginCheck((origin) => isPublishableKeyOrigin(db, origin));
  app.use(
    '/v1/public',
    cors({
      origin: (origin, allow) => {
        if (!origin) return allow(null, false);
        publicOrigin(origin).then(
          (ok) => allow(null, ok ? origin : false),
          (error: unknown) => allow(error as Error)
        );
      },
      credentials: false,
    })
  );
  app.use(
    '/v1/public',
    publicRoutes({
      db,
      rateLimitStore: deps.rateLimitStore,
      paymentClients: deps.paymentClients,
      appUrl: config.APP_URL,
    })
  );

  // Private routes are called by the web app's origin only. No wildcard.
  app.use(
    cors({
      origin: (origin, allow) => allow(null, origin === config.WEB_ORIGIN),
      credentials: true,
    })
  );
  // The routes ported from Next read their body as text and parse it
  // themselves, after authentication, with the Next routes' rules (JSON
  // whatever the Content-Type; a missing or broken body is the route's
  // decision). Every other route gets the JSON parser.
  const pathOf = (req: Parameters<RequestListener>[0]) => (req.url ?? '').split('?')[0]!;
  app.use(
    express.json({
      limit: JSON_LIMIT,
      type: (req) =>
        !isLegacyPath(pathOf(req)) &&
        /^application\/json\b/i.test(req.headers['content-type'] ?? ''),
    })
  );
  app.use(express.text({ limit: JSON_LIMIT, type: (req) => isLegacyPath(pathOf(req)) }));
  // Before the routes' own checks; on /v1 after the key check (below), so a
  // caller without a key gets 401 whatever its body holds.
  app.use((req, res, next) =>
    req.path.startsWith('/v1/') ? next() : rejectNulCharacters(req, res, next)
  );

  app.use('/internal', internalRoutes(config, deps.replayCache ?? new MemoryReplayCache(), db));

  // The public API. Every route acts in the workspace of the key it was
  // called with; nothing below reads a workspace from the request itself.
  const v1 = Router();
  v1.use(
    authFailureRateLimit(deps.rateLimitStore),
    requireApiKey(db),
    rejectNulCharacters,
    apiKeyRateLimit(deps.rateLimitStore),
    idempotency(db)
  );
  v1.use(
    webhookEndpointRoutes(db, {
      // http is tolerated outside production so a local receiver can be used.
      requireHttps: config.NODE_ENV !== 'development',
    })
  );
  v1.use(
    legacyV1Routes(db, {
      appUrl: config.APP_URL,
      email: deps.email,
      rateLimitStore: deps.rateLimitStore,
      onOutboxEvents: deps.onOutboxEvents,
    })
  );
  v1.use(leadRoutes(db));
  v1.use(pipelineRoutes(db));
  v1.use(dealRoutes(db));
  v1.use(invoiceRoutes(db, { paymentClients: deps.paymentClients, appUrl: config.APP_URL }));
  v1.use(reportRoutes(db));
  v1.use('/automations', automationRoutes(db));

  const router = Router();
  deps.extend?.(router);
  app.use(router);
  app.use('/v1', v1);

  app.use(notFound);
  app.use(errorHandler(logger, deps.report));
  return app;
}
