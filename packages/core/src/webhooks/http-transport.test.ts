import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHttpTransport } from './http-transport';

describe('webhook HTTP transport', () => {
  let server: Server;
  let port = 0;
  const received: {
    method?: string;
    url?: string;
    headers: Record<string, unknown>;
    body: string;
  }[] = [];
  let handler: (res: import('node:http').ServerResponse) => void;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        received.push({ method: req.method, url: req.url, headers: req.headers, body });
        handler(res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  beforeEach(() => {
    received.length = 0;
    handler = (res) => res.writeHead(200).end('ok');
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const request = {
    headers: { 'Content-Type': 'application/json', 'X-Test': '1' },
    body: '{"a":1}',
    timeoutMs: 2_000,
  };
  const local = createHttpTransport({ allowPrivateAddresses: true });
  const guarded = createHttpTransport();

  it('posts the body and headers and returns the status and response', async () => {
    const result = await local.post(`http://localhost:${port}/hook?x=1`, request);

    expect(result).toEqual({ status: 200, body: 'ok' });
    expect(received[0]).toMatchObject({ method: 'POST', url: '/hook?x=1', body: '{"a":1}' });
    expect(received[0]!.headers['x-test']).toBe('1');
  });

  it('refuses a hostname that resolves to a private address, before connecting', async () => {
    await expect(guarded.post(`http://localhost:${port}/hook`, request)).rejects.toThrow(/private/);
    expect(received).toHaveLength(0);
  });

  it('refuses a private IP literal', async () => {
    await expect(guarded.post(`http://127.0.0.1:${port}/hook`, request)).rejects.toThrow(/private/);
    expect(received).toHaveLength(0);
  });

  it('returns a redirect instead of following it', async () => {
    handler = (res) => res.writeHead(302, { Location: `http://localhost:${port}/elsewhere` }).end();

    const result = await local.post(`http://localhost:${port}/hook`, request);

    expect(result.status).toBe(302);
    expect(received).toHaveLength(1);
  });

  it('gives up after the timeout', async () => {
    handler = () => {};

    await expect(
      local.post(`http://localhost:${port}/hook`, { ...request, timeoutMs: 150 })
    ).rejects.toThrow(/timed out/);
  });

  it('stops reading a response that is larger than it will keep', async () => {
    handler = (res) => res.writeHead(200).end('x'.repeat(500_000));

    const result = await local.post(`http://localhost:${port}/hook`, request);

    expect(result.status).toBe(200);
    expect(result.body.length).toBeLessThanOrEqual(64 * 1024);
  });
});
