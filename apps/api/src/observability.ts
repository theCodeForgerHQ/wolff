import * as Sentry from '@sentry/node';
import {
  collectDefaultMetrics,
  Gauge,
  register as prometheusRegister,
} from '@prometheus-io/client';
import express, { type Express, type RequestHandler } from 'express';
import type { ApiConfig } from './config';
import { redactError } from './redact-error';

let otelSdk: { shutdown(): Promise<void> } | undefined;

/**
 * Loaded only when an OTLP endpoint is set: the auto-instrumentations are
 * about a hundred packages, and importing them cost every cold start of the
 * serverless API, which has no endpoint.
 */
async function startTracing(endpoint: string, version: string): Promise<void> {
  const [
    { NodeSDK },
    { OTLPTraceExporter },
    { getNodeAutoInstrumentations },
    resources,
    conventions,
  ] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/auto-instrumentations-node'),
    import('@opentelemetry/resources'),
    import('@opentelemetry/semantic-conventions'),
  ]);
  const sdk = new NodeSDK({
    resource: resources.resourceFromAttributes({
      [conventions.ATTR_SERVICE_NAME]: 'wolff-api',
      [conventions.ATTR_SERVICE_VERSION]: version,
    }),
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
    instrumentations: [getNodeAutoInstrumentations()],
  });
  sdk.start();
  otelSdk = sdk;
}

/**
 * How long a report may hold the response. On Vercel the function is frozen
 * as soon as it answers, so an event still queued in the SDK is lost: the
 * report waits for delivery, but not longer than this.
 */
const SENTRY_FLUSH_MS = 2000;

export interface ObservabilityOptions {
  /** Replaced in tests to observe what leaves the process. */
  transport?: Sentry.NodeOptions['transport'];
}

/**
 * Keeps request bodies, cookies, query strings and headers out of every
 * event: they carry API keys, sessions and client data. Method and path stay.
 */
export function stripRequestData<E extends Sentry.ErrorEvent>(event: E): E {
  if (!event.request) return event;
  const { method, url } = event.request;
  return { ...event, request: { method, url: url?.split('?')[0] } };
}

/**
 * Trace sampling: none for job runs, `rate` for everything else. A job run
 * is a scheduled background invocation; tracing it cost CPU in every one and
 * filled Sentry with performance issues (N+1, Blocking Operation) about the
 * scheduler rather than about requests.
 */
export function jobsUntracedSampler(rate: number) {
  return (context: { name?: string }): number => (context.name?.includes('/jobs/') ? 0 : rate);
}

export function initObservability(
  config: ApiConfig,
  options: ObservabilityOptions = {}
): { report: (error: unknown) => Promise<void> } {
  const report = async (error: unknown) => {
    if (!error) return;
    const { error: safe, fingerprint } = redactError(error);
    Sentry.captureException(safe, fingerprint ? { fingerprint } : undefined);
    console.error(safe);
    if (config.SENTRY_DSN) await Sentry.flush(SENTRY_FLUSH_MS);
  };

  if (config.SENTRY_DSN) {
    Sentry.init({
      dsn: config.SENTRY_DSN,
      environment: config.NODE_ENV,
      release: config.GIT_SHA,
      tracesSampler: jobsUntracedSampler(config.SENTRY_TRACES_SAMPLE_RATE),
      beforeSend: stripRequestData,
      ...(options.transport ? { transport: options.transport } : {}),
    });
  }

  if (config.OTEL_EXPORTER_OTLP_ENDPOINT) {
    void startTracing(config.OTEL_EXPORTER_OTLP_ENDPOINT, config.GIT_SHA ?? '0.1.0').catch(
      (error: unknown) => console.error('OpenTelemetry failed to start', error)
    );
  }

  new Gauge({
    name: 'wolff_app_info',
    help: 'Application version and environment',
    labelNames: ['version', 'environment'],
    registers: [prometheusRegister],
  }).set({ version: config.GIT_SHA ?? '0.1.0', environment: config.NODE_ENV }, 1);

  return { report };
}

export async function shutdownObservability(): Promise<void> {
  await Sentry.close(2000).catch(() => {});
  await otelSdk?.shutdown().catch(() => {});
}

export const metricsHandler: RequestHandler = async (_req, res) => {
  res.set('Content-Type', prometheusRegister.contentType);
  res.send(await prometheusRegister.metrics());
};

/**
 * `/metrics` on its own port (METRICS_PORT, 9464 by default), not on the
 * public API port: process and app internals are for the scraper inside the
 * network (internal port), not for anyone who can reach the API.
 */
export function createMetricsApp(): Express {
  // Process metrics are collected only where they are served: the
  // long-running server. A serverless invocation has no scraper.
  if (!prometheusRegister.getSingleMetric('wolff_process_cpu_user_seconds_total')) {
    collectDefaultMetrics({ register: prometheusRegister, prefix: 'wolff_' });
  }
  const app = express();
  app.disable('x-powered-by');
  app.get('/metrics', metricsHandler);
  return app;
}
