import express, { Router } from 'express';
import { InvalidJobError, isJobType, runJob, type Job, type JobContext } from '@wolff/jobs';
import type { QStashVerifier } from '@wolff/jobs/qstash';
import type { ApiConfig } from '../config';
import { sendData, sendError } from '../http';

/**
 * `POST /jobs/run/:type`: the push runtime of the free demo.
 * QStash calls it with a job; it runs the same processor a BullMQ worker
 * would. The URL is public, so a request is a job only if QStash signed it
 * for this exact URL and body. Without signing keys the route refuses
 * everything.
 *
 * The status tells QStash what to do: 2xx done, 4xx do not retry, 5xx retry.
 */
export interface JobRunDeps {
  verify: QStashVerifier;
  context: JobContext;
  /** Replaced in tests; the real one runs the processor. */
  run?: (context: JobContext, job: Job) => Promise<void>;
}

export function jobRoutes(config: ApiConfig, deps: JobRunDeps | undefined): Router {
  const router = Router();
  // Raw, because the signature carries a hash of the exact body.
  router.use(express.raw({ type: '*/*', limit: '1mb' }));

  router.post('/run/:type', async (req, res) => {
    const type = String(req.params.type);
    const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const verified =
      deps !== undefined &&
      (await deps.verify({
        signature: req.get('upstash-signature'),
        body,
        url: `${config.PUBLIC_API_URL.replace(/\/$/, '')}/jobs/run/${type}`,
      }));
    if (!deps || !verified) {
      return sendError(res, 'unauthorized', 'A valid job signature is required');
    }

    let job: Job;
    try {
      job = JSON.parse(body) as Job;
    } catch {
      return sendError(res, 'validation_error', 'Job body is not valid JSON');
    }
    if (!isJobType(type) || job?.type !== type || typeof job.jobId !== 'string') {
      return sendError(res, 'validation_error', 'Job does not match the route it was sent to');
    }

    try {
      await (deps.run ?? runJob)(deps.context, job);
    } catch (error) {
      if (error instanceof InvalidJobError) {
        return sendError(res, 'validation_error', error.message);
      }
      throw error;
    }
    sendData(res, { jobId: job.jobId, status: 'completed' });
  });

  return router;
}
