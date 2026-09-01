import { createPrisma, withTenantGuard } from '@wolff/database';
import { createRedis } from '@wolff/jobs/bullmq';
import { BullMQDispatcher, createJobQueue } from '@wolff/jobs/bullmq';
import { QStashDispatcher, createQStashVerifier } from '@wolff/jobs/qstash';
import { REBUILDABLE_TABLES } from '@wolff/jobs/backup';
import { Client as QStashClient } from '@upstash/qstash';
import { type Redis } from 'ioredis';
import { createApp, type AppDeps } from './app';
import type { ApiConfig } from './config';
import { redisRateLimitStore } from './middleware/auth';
import { MemoryReplayCache, RedisReplayCache } from './middleware/service-jwt';
import { createHttpTransport } from '@wolff/core/webhooks';
import {
  createAiIndexer,
  createChromiumPdfRenderer,
  createLocalStorage,
  createLogEmailTransport,
  createResendTransport,
  createS3BackupStore,
  createS3Storage,
  withDemoRedirect,
} from '@wolff/jobs/ports';
import { relayOutboxToJobs, type Job, type JobContext, type JobDispatcher } from '@wolff/jobs';
import type { Db } from '@wolff/core/context';
import { logger } from '@wolff/core/logger';
import type { Express } from 'express';
import { initObservability } from './observability';

export interface BootstrapDeps {
  app: Express;
  db: Db;
  redis?: Redis;
  appDeps: AppDeps;
  jobContext: JobContext;
  close: () => Promise<void>;
}

function createRedisConnection(url: string | undefined): Redis | undefined {
  if (!url) return undefined;
  return createRedis(url);
}

function createReplayCache(redis?: Redis) {
  return redis ? new RedisReplayCache(redis) : new MemoryReplayCache();
}

function createRateLimitStore(redis?: Redis) {
  return redis ? (prefix: string) => redisRateLimitStore(redis, prefix) : undefined;
}

class NoOpDispatcher implements JobDispatcher {
  async dispatch(job: Job): Promise<void> {
    logger.warn(
      { jobType: job.type, jobId: job.jobId },
      'No job dispatcher configured; job dropped'
    );
  }
}

function createJobDispatcher(config: ApiConfig, redis?: Redis): JobDispatcher {
  if (config.JOB_DISPATCHER === 'qstash') {
    if (
      !config.QSTASH_TOKEN ||
      !config.QSTASH_CURRENT_SIGNING_KEY ||
      !config.QSTASH_NEXT_SIGNING_KEY
    ) {
      logger.warn('QStash dispatcher selected but keys are missing; jobs will be dropped');
      return new NoOpDispatcher();
    }
    return new QStashDispatcher({
      client: new QStashClient({ token: config.QSTASH_TOKEN }),
      apiUrl: config.PUBLIC_API_URL,
    });
  }
  if (!redis) {
    logger.warn('BullMQ dispatcher selected but REDIS_URL is missing; jobs will be dropped');
    return new NoOpDispatcher();
  }
  return new BullMQDispatcher(createJobQueue(redis));
}

function createJobRunDeps(config: ApiConfig, ctx: JobContext, redis?: Redis): AppDeps['jobs'] {
  if (!config.QSTASH_CURRENT_SIGNING_KEY || !config.QSTASH_NEXT_SIGNING_KEY) return undefined;
  return {
    verify: createQStashVerifier({
      currentSigningKey: config.QSTASH_CURRENT_SIGNING_KEY,
      nextSigningKey: config.QSTASH_NEXT_SIGNING_KEY,
    }),
    context: ctx,
  };
}

export function createEmailTransport(config: ApiConfig): JobContext['email'] {
  const transport =
    config.RESEND_API_KEY && config.EMAIL_FROM
      ? createResendTransport({ apiKey: config.RESEND_API_KEY, from: config.EMAIL_FROM })
      : createLogEmailTransport((entry) => logger.info(entry, 'email would be sent'));
  return config.demoEmailRedirect
    ? withDemoRedirect(transport, config.demoEmailRedirect)
    : transport;
}

function createStorage(config: ApiConfig): JobContext['storage'] {
  const provider = process.env.STORAGE_PROVIDER ?? 'local';
  if (provider === 's3' || provider === 'cloudflare') {
    const bucket = process.env.STORAGE_BUCKET;
    if (!bucket) throw new Error('STORAGE_BUCKET is required for S3 storage');
    return createS3Storage({
      bucket,
      region: process.env.STORAGE_REGION ?? 'us-east-1',
      endpoint: process.env.STORAGE_ENDPOINT,
      accessKeyId: process.env.STORAGE_ACCESS_KEY,
      secretAccessKey: process.env.STORAGE_SECRET_KEY,
    });
  }
  return createLocalStorage(process.env.STORAGE_LOCAL_PATH ?? './uploads');
}

/** The schemas a backup covers: Prisma's `public` and the AI service's `ai`. */
export const BACKUP_SCHEMAS = ['public', 'ai'];

function createBackups(config: ApiConfig): JobContext['backups'] {
  if (!config.BACKUP_BUCKET) return undefined;
  return {
    store: createS3BackupStore({
      bucket: config.BACKUP_BUCKET,
      region: process.env.STORAGE_REGION ?? 'us-east-1',
      endpoint: process.env.STORAGE_ENDPOINT,
      accessKeyId: process.env.STORAGE_ACCESS_KEY,
      secretAccessKey: process.env.STORAGE_SECRET_KEY,
    }),
    keepDays: config.BACKUP_RETENTION_DAYS,
    schemas: BACKUP_SCHEMAS,
    exclude: REBUILDABLE_TABLES,
  };
}

/**
 * Pushes the outbox events a request just committed to the dispatcher, so
 * they don't wait for the relay's next pass. Never rejects: the outbox row
 * is the record, and a failed push is picked up by the relay and sweeper.
 * Callers await it before answering, so a serverless freeze can't cut it off.
 */
export function createOutboxPush(db: Db, dispatcher: JobDispatcher) {
  // The same routine as the relay: each row becomes the job its type maps
  // to (jobForOutboxEvent), under `outbox:<id>`, and is marked enqueued.
  return (ids: string[]): Promise<void> =>
    relayOutboxToJobs(db, dispatcher, { ids, limit: ids.length }).then(
      () => undefined,
      (error: unknown) => {
        logger.error({ err: error, outboxEventIds: ids }, 'Failed to push outbox events');
      }
    );
}

export function bootstrap(config: ApiConfig): BootstrapDeps {
  const { report } = initObservability(config);
  const base = createPrisma(process.env.DATABASE_URL);
  const db = withTenantGuard(base, { mode: 'throw' });
  const redis = createRedisConnection(config.REDIS_URL);
  const replayCache = createReplayCache(redis);
  const rateLimitStore = createRateLimitStore(redis);

  const jobContext: JobContext = {
    db,
    dispatch: () => Promise.resolve(),
    email: createEmailTransport(config),
    webhooks: createHttpTransport({ allowPrivateAddresses: config.NODE_ENV === 'development' }),
    pdf: createChromiumPdfRenderer({
      executablePath: process.env.CHROME_EXECUTABLE_PATH,
      protectionBypass: config.WEB_PROTECTION_BYPASS
        ? { origin: config.APP_URL, secret: config.WEB_PROTECTION_BYPASS }
        : undefined,
    }),
    storage: createStorage(config),
    backups: createBackups(config),
    ai:
      config.AI_URL && config.SVC_JWT_SECRET_WORKER
        ? createAiIndexer({ baseUrl: config.AI_URL, secret: config.SVC_JWT_SECRET_WORKER })
        : undefined,
    appUrl: config.APP_URL,
    requireHttpsWebhooks: config.NODE_ENV !== 'development',
    now: () => new Date(),
  };

  const dispatcher = createJobDispatcher(config, redis);
  jobContext.dispatch = (job) => dispatcher.dispatch(job);

  const appDeps: AppDeps = {
    db,
    config,
    replayCache,
    rateLimitStore,
    jobs: createJobRunDeps(config, jobContext, redis),
    onOutboxEvents: createOutboxPush(db, dispatcher),
    // The ported send routes need a real provider: without one they answer
    // 502, as the Next routes did, instead of "sending" to the log.
    // Tests and the Schemathesis job run without a provider and get the log
    // transport, so the send routes can succeed there.
    email:
      (config.RESEND_API_KEY && config.EMAIL_FROM) || config.NODE_ENV === 'test'
        ? jobContext.email
        : undefined,
  };

  const app = createApp({ ...appDeps, report });

  return {
    app,
    db,
    redis,
    appDeps,
    jobContext,
    close: async () => {
      await redis?.quit();
      await base.$disconnect();
    },
  };
}
