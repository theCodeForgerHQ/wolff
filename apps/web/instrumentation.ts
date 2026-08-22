import * as Sentry from '@sentry/nextjs';
import { demoEmailRedirect } from '@wolff/core/email';

export async function register() {
  // Demo mode must not start without somewhere safe to send email: throws.
  demoEmailRedirect(process.env);
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

// Errors from server components, route handlers, server actions and the proxy.
export const onRequestError = Sentry.captureRequestError;
