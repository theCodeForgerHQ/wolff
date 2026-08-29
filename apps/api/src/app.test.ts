import { request } from './testing/request';
import { describe, expect, it } from 'vitest';
import type { Db } from '@wolff/core/context';
import { CoreError } from '@wolff/core/errors';
import { createApp } from './app';
import { testConfig } from './testing/harness';

/** A database stand-in for routes that only ask whether it answers. */
const db = (alive: boolean) =>
  ({
    $unscoped: {
      $queryRaw: async () => {
        if (!alive) throw new Error('connect ECONNREFUSED 10.0.0.5:5432');
        return [{ ok: 1 }];
      },
    },
  }) as unknown as Db;

const app = (alive = true) =>
  createApp({
    db: db(alive),
    config: testConfig(),
    extend: (router) => {
      router.post('/echo', (req, res) => res.json({ success: true, data: req.body }));
      router.get('/boom', () => {
        throw new Error('password=hunter2 leaked from a stack trace');
      });
      router.get('/async-boom', async () => {
        throw new Error('async failure');
      });
      router.get('/rule', () => {
        throw new CoreError('business_rule', 'Invoice is already paid');
      });
    },
  });

describe('API shell', () => {
  it('answers /healthz without touching the database', async () => {
    const res = await request(app(false)).get('/healthz');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('is ready only when the database answers', async () => {
    expect((await request(app(true)).get('/readyz')).status).toBe(200);

    const down = await request(app(false)).get('/readyz');
    expect(down.status).toBe(503);
    expect(down.body).toEqual({ status: 'unavailable', checks: { database: 'down' } });
    expect(JSON.stringify(down.body)).not.toContain('10.0.0.5');
  });

  it('answers an unknown route with the error envelope', async () => {
    const res = await request(app()).get('/nope');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'not_found', message: 'Not found' },
    });
  });

  it('rejects a body that is not JSON with validation_error', async () => {
    const res = await request(app())
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send('{"broken":');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, error: { code: 'validation_error' } });
  });

  it('rejects a body over 1 MB', async () => {
    const res = await request(app())
      .post('/echo')
      .send({ blob: 'x'.repeat(1_100_000) });

    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ success: false, error: { code: 'validation_error' } });
  });

  it.each(['/boom', '/async-boom'])(
    'turns an unexpected error on %s into a bare 500',
    async (path) => {
      const res = await request(app()).get(path);

      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        success: false,
        error: { code: 'internal_error', message: 'An unexpected error occurred' },
      });
    }
  );

  it('answers a 500 only after the error report has finished', async () => {
    const order: string[] = [];
    const reporting = createApp({
      db: db(true),
      config: testConfig(),
      report: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push('reported');
      },
      extend: (router) => {
        router.get('/boom', () => {
          throw new Error('boom');
        });
      },
    });

    const res = await request(reporting).get('/boom');
    order.push('answered');

    expect(res.status).toBe(500);
    expect(order).toEqual(['reported', 'answered']);
  });

  it('still answers a 500 when the error report itself fails', async () => {
    const failing = createApp({
      db: db(true),
      config: testConfig(),
      report: async () => {
        throw new Error('sentry is down');
      },
      extend: (router) => {
        router.get('/boom', () => {
          throw new Error('boom');
        });
      },
    });

    expect((await request(failing).get('/boom')).status).toBe(500);
  });

  // A Prisma validation error that reaches the handler is a value the route
  // failed to check: a server bug, reported like any other, not a 400.
  it.each(['/v1/clients', '/elsewhere'])(
    'reports a Prisma validation error on %s as a 500',
    async (path) => {
      const reported: unknown[] = [];
      const prismaError = Object.assign(new Error('Argument `id`: Invalid value'), {
        name: 'PrismaClientValidationError',
      });
      const failing = createApp({
        db: db(true),
        config: testConfig(),
        report: (error) => {
          reported.push(error);
        },
        extend: (router) => {
          router.get(path, () => {
            throw prismaError;
          });
        },
      });

      const res = await request(failing).get(path);

      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ error: { code: 'internal_error' } });
      expect(reported).toEqual([prismaError]);
    }
  );

  it('maps a core error to its documented status', async () => {
    const res = await request(app()).get('/rule');

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'business_rule', message: 'Invoice is already paid' },
    });
  });

  it('sets the hardening headers and does not advertise Express', async () => {
    const res = await request(app()).get('/healthz');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('allows the web origin with credentials and no other origin', async () => {
    const allowed = await request(app())
      .options('/v1/webhook-endpoints')
      .set('Origin', 'https://app.example.test')
      .set('Access-Control-Request-Method', 'POST');
    const other = await request(app())
      .options('/v1/webhook-endpoints')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');

    expect(allowed.headers['access-control-allow-origin']).toBe('https://app.example.test');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
});
