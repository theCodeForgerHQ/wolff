import * as Sentry from '@sentry/node';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import {
  collectDefaultMetrics,
  Gauge,
  register as prometheusRegister,
} from '@prometheus-io/client';
import express, { type Express, type RequestHandler } from 'express';
import type { ApiConfig } from './config';
import { redactError } from './redact-error';

let otelSdk: NodeSDK | undefined;

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
      tracesSampleRate: config.SENTRY_TRACES_SAMPLE_RATE,
      beforeSend: stripRequestData,
      ...(options.transport ? { transport: options.transport } : {}),
    });
  }

  if (config.OTEL_EXPORTER_OTLP_ENDPOINT) {
    otelSdk = new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: 'wolff-api',
        [ATTR_SERVICE_VERSION]: config.GIT_SHA ?? '0.1.0',
      }),
      traceExporter: new OTLPTraceExporter({ url: config.OTEL_EXPORTER_OTLP_ENDPOINT }),
      instrumentations: [getNodeAutoInstrumentations()],
    });
    otelSdk.start();
  }

  collectDefaultMetrics({ register: prometheusRegister, prefix: 'wolff_' });

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
  const app = express();
  app.disable('x-powered-by');
  app.get('/metrics', metricsHandler);
  return app;
}
