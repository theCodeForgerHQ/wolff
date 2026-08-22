import { Writable } from 'node:stream';
import express from 'express';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { request } from '../testing/request';
import { requestLogger } from './request-log';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  return { logger: pino({ level: 'info' }, stream), lines };
}

describe('request logging', () => {
  it('logs the path but never the query string or Vercel tokens', async () => {
    const { logger, lines } = capture();
    const app = express();
    app.use(requestLogger(logger, { autoLogging: true }));
    app.post('/webhooks/stripe', (_req, res) => res.json({ ok: true }));

    const res = await request(app)
      .post('/webhooks/stripe?x-vercel-protection-bypass=bypass-secret&token=tok-secret')
      .set('x-vercel-protection-bypass', 'header-secret')
      .set('x-vercel-oidc-token', 'oidc-secret')
      .set('authorization', 'Bearer bearer-secret');

    expect(res.status).toBe(200);
    const log = lines.join('');
    expect(log).toContain('"url":"/webhooks/stripe"');
    for (const secret of [
      'bypass-secret',
      'tok-secret',
      'header-secret',
      'oidc-secret',
      'bearer-secret',
    ]) {
      expect(log).not.toContain(secret);
    }
  });
});
