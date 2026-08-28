import { Router } from 'express';
import type { Db } from '@wolff/core/context';
import type { EmailTransport } from '@wolff/jobs';
import type { RateLimitStoreFactory } from '../../../middleware/auth';
import { documentEmailSender, type DocumentEmailSender } from './email';
import { clientRoutes } from './clients';
import { legacyInvoiceRoutes } from './invoices';
import { quoteRoutes } from './quotes';

export interface LegacyRouteDeps {
  /** Origin of the web app, for the portal links in emails and responses. */
  appUrl: string;
  email?: EmailTransport;
  rateLimitStore?: RateLimitStoreFactory;
  /** Told about outbox events a request committed (PDF render, AI index). */
  onOutboxEvents?: (ids: string[]) => void | Promise<void>;
}

export interface LegacyRouteContext extends LegacyRouteDeps {
  /** One sender, so quotes and invoices draw on the same hourly email limit. */
  sendEmail: DocumentEmailSender;
}

/**
 * `/v1/clients`, `/v1/quotes` and `/v1/invoices`: the 11 route files of the
 * Next app's `/api/v1`, ported with their request and response contract.
 * Mounted after API-key authentication, rate limiting and
 * Idempotency-Key handling; each route also requires its scopes.
 */
export function legacyV1Routes(db: Db, deps: LegacyRouteDeps): Router {
  const router = Router();
  const context: LegacyRouteContext = {
    ...deps,
    sendEmail: documentEmailSender(deps.email, deps.rateLimitStore),
  };
  router.use(clientRoutes(db, context));
  router.use(quoteRoutes(db, context));
  router.use(legacyInvoiceRoutes(db, context));
  return router;
}
