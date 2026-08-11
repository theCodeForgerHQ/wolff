import { bootstrap } from './bootstrap';
import { loadConfig } from './config';
import { createMetricsApp } from './observability';
import { logger } from '@wolff/core/logger';

const config = loadConfig();
const { app, close } = bootstrap(config);

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT, env: config.NODE_ENV }, 'API server listening');
});
// Internal only: the port is not published by the load balancer.
const metricsServer = createMetricsApp().listen(config.METRICS_PORT, () => {
  logger.info({ port: config.METRICS_PORT }, 'Metrics listening');
});

async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down');
  server.close(() => {});
  metricsServer.close(() => {});
  await close().catch((error) => logger.error({ err: error }, 'Error during shutdown'));
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
