import { z } from 'zod';
import { demoEmailRedirect } from '@wolff/core/email';

/**
 * Everything the API and the worker read from the environment, parsed once.
 * A value that is present but malformed stops the process at start; an
 * absent optional integration is switched off and its routes say so.
 */
const optional = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value ? value : undefined));
const url = z.string().trim().url();

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  /** Origin of the web app; the only origin allowed on private routes. */
  WEB_ORIGIN: url.default('http://localhost:3000'),
  /** The web app's public URL, for links in emails and PDF rendering. */
  APP_URL: url.default('http://localhost:3000'),
  /**
   * The web project's Vercel protection-bypass secret. Only the PDF renderer
   * sends it, only to APP_URL's origin; unset when the web is not protected.
   */
  WEB_PROTECTION_BYPASS: optional,
  /** This service's public URL, as QStash calls it. */
  PUBLIC_API_URL: url.default('http://localhost:4000'),

  REDIS_URL: optional,
  JOB_DISPATCHER: z.enum(['bullmq', 'qstash']).default('bullmq'),
  QSTASH_TOKEN: optional,
  QSTASH_CURRENT_SIGNING_KEY: optional,
  QSTASH_NEXT_SIGNING_KEY: optional,

  STRIPE_WEBHOOK_SECRET: optional,
  STRIPE_CONNECT_WEBHOOK_SECRET: optional,

  /** One secret per service that may call /internal. */
  SVC_JWT_SECRET_WEB: optional,
  SVC_JWT_SECRET_AI: optional,
  SVC_JWT_SECRET_WORKER: optional,
  SVC_JWT_SECRET_LAMBDA: optional,

  /** The AI service's origin. Unset: AI jobs do nothing and the product runs without it. */
  AI_URL: optional,

  RESEND_API_KEY: optional,
  EMAIL_FROM: optional,
  /** "true" in the free demo; see demoEmailRedirect for what it requires. */
  DEMO_MODE: optional,
  DEMO_EMAIL_REDIRECT: optional,

  /** Bucket for the nightly database backup (same S3 endpoint and keys as STORAGE_*). */
  BACKUP_BUCKET: optional,
  BACKUP_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(14),

  SENTRY_DSN: optional,
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
  OTEL_EXPORTER_OTLP_ENDPOINT: optional,
  METRICS_PORT: z.coerce.number().int().min(1).max(65_535).default(9464),
  GIT_SHA: optional,
});

export type ApiConfig = z.infer<typeof schema> & {
  isProduction: boolean;
  /** Set in demo mode: every outgoing email goes here instead. */
  demoEmailRedirect?: string;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n  ${problems.join('\n  ')}`);
  }
  return {
    ...parsed.data,
    isProduction: parsed.data.NODE_ENV === 'production',
    // Throws in demo mode without a redirect: the process must not start.
    demoEmailRedirect: demoEmailRedirect({
      DEMO_MODE: parsed.data.DEMO_MODE,
      DEMO_EMAIL_REDIRECT: parsed.data.DEMO_EMAIL_REDIRECT,
    }),
  };
}
