import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { request } from './request';

describe('request(app) for the API tests', () => {
  it('serves the request from a server bound to 127.0.0.1, the address it connects to', async () => {
    let served = '';
    const app = createServer((req, res) => {
      served = req.socket.localAddress ?? '';
      res.end('ok');
    });

    const res = await request(app).get('/');

    expect(res.status).toBe(200);
    expect(served).toBe('127.0.0.1');
  });

  it('closes the server it started once the requests are done, and can start it again', async () => {
    const app = createServer((_req, res) => res.end('ok'));
    const client = request(app);

    await Promise.all([client.get('/a').expect(200), client.get('/b').expect(200)]);
    expect(app.listening).toBe(false);

    await client.get('/c').expect(200);
    expect(app.listening).toBe(false);
  });

  it('keeps supertest assertions and chaining', async () => {
    const app = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ method: req.method, auth: req.headers.authorization ?? null }));
    });

    await request(app)
      .post('/x')
      .set('Authorization', 'Bearer k')
      .send({})
      .expect(200, { method: 'POST', auth: 'Bearer k' });
  });
});
