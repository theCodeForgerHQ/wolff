import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { loadConfig } from '../config';

describe('/openapi.json and /docs', () => {
  const config = loadConfig({ ...process.env, NODE_ENV: 'test' });
  const app = createApp({ db: {} as never, config });

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
});
