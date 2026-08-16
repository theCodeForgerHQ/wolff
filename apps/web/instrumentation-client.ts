import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { sentryOptions } from '@/lib/observability/sentry';

// Zod 4 compiles fast parsers with `new Function` after probing whether
// eval is allowed. The CSP (lib/security/csp.ts) has no 'unsafe-eval', so
// the probe is blocked and reported as a violation on every page with a
// form. Jitless mode skips the probe and parses without generated code.
z.config({ jitless: true });

// Uncaught errors and unhandled rejections are captured by the SDK's default
// global handlers; GlobalErrorHandler only shows the user a toast.
Sentry.init(sentryOptions(process.env.NEXT_PUBLIC_SENTRY_DSN));

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
