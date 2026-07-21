import * as Sentry from '@sentry/nextjs';
import { sentryOptions } from '@/lib/observability/sentry';

// Uncaught errors and unhandled rejections are captured by the SDK's default
// global handlers; GlobalErrorHandler only shows the user a toast.
Sentry.init(sentryOptions(process.env.NEXT_PUBLIC_SENTRY_DSN));

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
