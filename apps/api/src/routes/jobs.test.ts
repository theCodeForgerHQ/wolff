import { createHash, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { request } from '../testing/request';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@wolff/core/context';
import { createQStashVerifier } from '@wolff/jobs/qstash';
import type { Job, JobContext } from '@wolff/jobs';
import { createApp } from '../app';
import { testConfig } from '../testing/harness';

const CURRENT = 'sig_current';
const NEXT = 'sig_next';
const API = 'https://api.example.test';

async function signature(url: string, body: string, key = CURRENT): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ body: createHash('sha256').update(body).digest('base64url') })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('Upstash')
    .setSubject(url)
    .setIssuedAt(now)
    .setNotBefore(now - 5)
    .setExpirationTime(now + 300)
    .setJti(randomUUID())
    .sign(new TextEncoder().encode(key));
}

function setup(
  run: (ctx: JobContext, job: Job) => Promise<void>,
  onExhausted?: (ctx: JobContext, job: Job, error: unknown) => Promise<void>,
  report: (error: unknown) => void = () => {}
) {
  const app = createApp({
    report,
    db: {} as Db,
    config: testConfig({ PUBLIC_API_URL: API }),
    jobs: {
      verify: createQStashVerifier({ currentSigningKey: CURRENT, nextSigningKey: NEXT }),
      context: { marker: 'ctx' } as unknown as JobContext,
      run,
      onExhausted,
    },
  });
  const post = async (
    type: string,
    job: unknown,
    options: { sign?: boolean; key?: string; url?: string; retried?: number } = {}
  ) => {
    const body = JSON.stringify(job);
    const req = request(app).post(`/jobs/run/${type}`).set('Content-Type', 'application/json');
    if (options.retried !== undefined) req.set('Upstash-Retried', String(options.retried));
    if (options.sign !== false) {
      req.set(
        'Upstash-Signature',
        await signature(options.url ?? `${API}/jobs/run/${type}`, body, options.key)
      );
    }
    return req.send(body);
  };
  return { app, post };
}

const job: Job = {
  type: 'email.send',
  payload: { scheduledEmailId: 'email-1', workspaceId: 'ws-1' },
  jobId: 'outbox:1',
  outboxEventId: '1',
};

describe('POST /jobs/run/:type', () => {
  it('runs a job that QStash signed for this URL and body', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const { post } = setup(run);

    const res = await post('email.send', job);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { jobId: 'outbox:1', status: 'completed' } });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![1]).toEqual(job);
  });

  it.each([
    ['without a signature', { sign: false }],
    ['signed with another key', { key: 'attacker' }],
    ['signed for another URL', { url: `${API}/jobs/run/payments.reconcile` }],
  ])('answers 401 and runs nothing for a request %s', async (_name, options) => {
    const run = vi.fn();
    const { post } = setup(run);

    const res = await post('email.send', job, options);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'unauthorized', message: 'A valid job signature is required' },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('answers 401 for everything when no signing keys are configured', async () => {
    const closed = createApp({ db: {} as Db, config: testConfig({ PUBLIC_API_URL: API }) });
    const body = JSON.stringify(job);

    const res = await request(closed)
      .post('/jobs/run/email.send')
      .set('Content-Type', 'application/json')
      .set('Upstash-Signature', await signature(`${API}/jobs/run/email.send`, body))
      .send(body);

    expect(res.status).toBe(401);
  });

  // QStash retries every answer that is not 2xx, unless it is 489 with
  // Upstash-NonRetryable-Error: true (upstash.com/docs/qstash/features/retry).
  const expectNotRetried = (res: { status: number; headers: Record<string, string> }) => {
    expect(res.status).toBe(489);
    expect(res.headers['upstash-nonretryable-error']).toBe('true');
  };

  it('refuses, without retries, a signed job whose type is not the one in the URL', async () => {
    const run = vi.fn();
    const { post } = setup(run);

    const res = await post('email.send', { ...job, type: 'payments.reconcile' });

    expectNotRetried(res);
    expect(run).not.toHaveBeenCalled();
  });

  it('answers a job that can never succeed so that QStash does not retry it', async () => {
    const { InvalidJobError } = await import('@wolff/jobs');
    const { post } = setup(async () => {
      throw new InvalidJobError('email.send', 'bad payload');
    });

    const res = await post('email.send', job);

    expectNotRetried(res);
    expect(res.body.error.code).toBe('validation_error');
  });

  // While Neon was over quota every run failed this way; each one became a
  // Sentry error and a fast retry.
  it.each([
    [
      'Neon over its quota',
      Object.assign(
        new Error(
          'Invalid `prisma.automation.findMany()` invocation: Database error. Code: `53000`. Message: `Your account or project has exceeded the quota.`'
        ),
        { code: 'P2039', name: 'PrismaClientKnownRequestError' }
      ),
    ],
    [
      'an unreachable server',
      Object.assign(new Error("Can't reach database server"), { code: 'P1001' }),
    ],
    ['a dropped connection', new Error('Connection terminated due to connection timeout')],
    [
      'a pool client after an error',
      new Error('Client has encountered a connection error and is not queryable'),
    ],
  ])('answers 503 with Retry-After, and no error report, for %s', async (_label, error) => {
    const report = vi.fn();
    const { post } = setup(
      async () => {
        throw error;
      },
      undefined,
      report
    );

    const res = await post('email.send', job);

    expect(res.status).toBe(503);
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(600);
    expect(report).not.toHaveBeenCalled();
  });

  it('answers 500, which QStash retries, when the job fails', async () => {
    const { post } = setup(async () => {
      throw new Error('Resend answered 503 for someone@example.com');
    });

    const res = await post('email.send', job);

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('someone@example.com');
  });
  it('records the failure for good on the last delivery QStash will make', async () => {
    const exhausted = vi.fn(async () => {});
    const { post } = setup(async () => {
      throw new Error('still failing');
    }, exhausted);

    await post('email.send', job, { retried: 1 });
    expect(exhausted).not.toHaveBeenCalled();

    const res = await post('email.send', job, { retried: 3 });

    expect(res.status).toBe(500);
    expect(exhausted).toHaveBeenCalledWith(
      { marker: 'ctx' },
      expect.objectContaining({ jobId: 'outbox:1' }),
      expect.any(Error)
    );
  });

  it('still records the job as failed on the last delivery when the database looks down', async () => {
    const exhausted = vi.fn(async () => {});
    const { post } = setup(async () => {
      throw new Error('Connection terminated unexpectedly');
    }, exhausted);

    const res = await post('email.send', job, { retried: 3 });

    expect(res.status).toBe(503);
    expect(exhausted).toHaveBeenCalled();
  });
});
