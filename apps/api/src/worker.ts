import {
  createRedis,
  createJobQueue,
  drainJobs,
  registerSchedulers,
  startJobWorker,
  startOutboxRelay,
} from '@wolff/jobs/bullmq';
import { bootstrap } from './bootstrap';
import { loadConfig } from './config';
import { logger } from '@wolff/core/logger';
import { shutdownObservability } from './observability';

const config = loadConfig();
const { jobContext, redis, close } = bootstrap(config);

if (!redis) {
  logger.error('Worker requires REDIS_URL');
  process.exit(1);
}

const queue = createJobQueue(redis);
const dispatcher = {
  dispatch: (job: Parameters<typeof jobContext.dispatch>[0]) => jobContext.dispatch(job),
};

const worker = startJobWorker({
  connection: redis,
  ctx: { ...jobContext, dispatch: dispatcher.dispatch },
  onError: (error, job) => {
    logger.error({ err: error, jobType: job?.type, jobId: job?.jobId }, 'Job failed');
  },
});

const relay = startOutboxRelay({
  db: jobContext.db,
  dispatcher,
  onError: (error) => logger.error({ err: error }, 'Outbox relay error'),
});

async function shutdown(signal: string) {
  logger.info({ signal }, 'Worker shutting down');
  relay.stop();
  await worker.close();
  await queue.close();
  await close();
  await shutdownObservability();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

(async () => {
  const ids = await registerSchedulers(queue);
  logger.info({ schedulers: ids }, 'Worker started');
})().catch((error) => {
  logger.error({ err: error }, 'Worker startup failed');
  process.exit(1);
});
