import { afterAll, describe, expect, it } from 'vitest';
import { request } from '../testing/request';
import { bootstrap } from '../bootstrap';
import { loadConfig } from '../config';
import { createMetricsApp } from '../observability';

describe('/openapi.json and /docs', () => {
  const config = loadConfig({ ...process.env, NODE_ENV: 'test' });
  const { app, close } = bootstrap(config);

  afterAll(async () => {
    await close();
  });

  it('serves the OpenAPI document without authentication', async () => {
    const res = await request(app).get('/openapi.json');

    expect(res.status).toBe(200);
    expect(res.body.openapi).toMatch(/^3\.0\.\d+$/);
    expect(res.body.info.title).toBe('Wolff API');
    expect(res.body.paths).toHaveProperty('/v1/webhook-endpoints');
  });

  it('documents every route ported from the Next /api/v1', async () => {
    const res = await request(app).get('/openapi.json');
    const paths = res.body.paths as Record<string, Record<string, unknown>>;
    const ported = {
      '/v1/clients': ['get', 'post'],
      '/v1/clients/import': ['post'],
      '/v1/clients/{id}': ['get', 'patch', 'delete'],
      '/v1/quotes': ['get', 'post'],
      '/v1/quotes/{id}': ['get', 'patch', 'delete'],
      '/v1/quotes/{id}/send': ['post'],
      '/v1/quotes/{id}/duplicate': ['post'],
      '/v1/invoices': ['get', 'post'],
      '/v1/invoices/{id}': ['get', 'patch', 'delete'],
      '/v1/invoices/{id}/send': ['post'],
      '/v1/invoices/from-quote/{quoteId}': ['post'],
    };
    for (const [path, methods] of Object.entries(ported)) {
      expect(Object.keys(paths[path] ?? {}).sort(), path).toEqual([...methods].sort());
    }
  });

  // The route answers 400 without it; a client (or a fuzzer) reading the
  // document must be told, not only in prose.
  it('declares the Idempotency-Key header that payment links require', async () => {
    const res = await request(app).get('/openapi.json');
    const op = res.body.paths['/v1/invoices/{id}/payment-links'].post;
    expect(op.parameters).toContainEqual(
      expect.objectContaining({
        in: 'header',
        name: 'Idempotency-Key',
        required: true,
        schema: expect.objectContaining({ minLength: 1, maxLength: 255 }),
      })
    );
  });

  it('serves the Scalar docs UI without authentication', async () => {
    const res = await request(app).get('/docs');

    expect(res.status).toBe(200);
    expect(res.text).toContain('scalar');
    expect(res.text).toContain('/openapi.json');
  });

  it('does not serve Prometheus metrics on the public port', async () => {
    const res = await request(app).get('/metrics');

    expect(res.status).toBe(404);
  });

  it('serves Prometheus metrics on the separate metrics app (internal port)', async () => {
    const res = await request(createMetricsApp()).get('/metrics');

    expect(res.status).toBe(200);
    expect(res.text).toContain('wolff_');
    expect(res.get('content-type')).toContain('text/plain');
  });
});
