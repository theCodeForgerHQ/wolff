import { createRedis, drainJobs } from '@wolff/jobs/bullmq';
import { bootstrap } from './bootstrap';
import { loadConfig } from './config';
import { logger } from '@wolff/core/logger';
import { shutdownObservability } from './observability';

const config = loadConfig();
const { jobContext, redis, close } = bootstrap(config);

if (!redis) {
  logger.error('Drain requires REDIS_URL');
  process.exit(1);
}

(async () => {
  const summary = await drainJobs({
    connection: redis,
    ctx: jobContext,
    onError: (error, job) =>
      logger.error({ err: error, jobType: job?.type, jobId: job?.jobId }, 'Drain job failed'),
  });
  logger.info(summary, 'Drain complete');
  await close();
  await shutdownObservability();
  if (summary.timedOut || summary.remaining > 0) process.exit(1);
})().catch(async (error) => {
  logger.error({ err: error }, 'Drain failed');
  await close();
  await shutdownObservability();
  process.exit(1);
});
