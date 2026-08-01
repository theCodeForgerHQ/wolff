import { bootstrap } from './bootstrap';
import { loadConfig } from './config';
import { logger } from '@wolff/core/logger';

const config = loadConfig();
const { app, close } = bootstrap(config);

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT, env: config.NODE_ENV }, 'API server listening');
});

async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down');
  server.close(() => {});
  await close().catch((error) => logger.error({ err: error }, 'Error during shutdown'));
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
