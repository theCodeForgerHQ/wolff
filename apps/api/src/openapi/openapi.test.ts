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
