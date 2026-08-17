import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { request } from '../testing/request';
import { describe, expect, it } from 'vitest';
import type { Db } from '@wolff/core/context';
import { createApp } from '../app';
import { testConfig } from '../testing/harness';
import { MemoryReplayCache, mintServiceJwt } from './service-jwt';

const WEB = 'web-secret-web-secret-web-secret-32';
const AI = 'ai-secret-ai-secret-ai-secret-ai-32!';
const WORKER = 'worker-secret-worker-secret-worker32';

const app = createApp({
  db: {} as Db,
  config: testConfig({
    SVC_JWT_SECRET_WEB: WEB,
    SVC_JWT_SECRET_AI: AI,
    SVC_JWT_SECRET_WORKER: WORKER,
  }),
  replayCache: new MemoryReplayCache(),
});
const call = (token?: string) => {
  const req = request(app).get('/internal/healthz');
  return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
};
const valid = (overrides: Partial<Parameters<typeof mintServiceJwt>[0]> = {}) =>
  mintServiceJwt({
    issuer: 'web',
    secret: WEB,
    audience: 'api',
    subject: 'user-1',
    workspaceId: 'ws-1',
    scopes: ['quotes:write'],
    ...overrides,
  });

/** A token built by hand, for the cases mintServiceJwt would never produce. */
async function craft(options: {
  secret?: string;
  alg?: string;
  kid?: string;
  claims?: Record<string, unknown>;
  exp?: number | null;
  iat?: number;
  jti?: string | null;
}) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({ workspaceId: 'ws-1', scopes: [], ...options.claims })
    .setProtectedHeader({ alg: options.alg ?? 'HS256', kid: options.kid ?? 'web' })
    .setIssuer((options.claims?.iss as string) ?? 'web')
    .setAudience((options.claims?.aud as string) ?? 'api')
    .setSubject('user-1')
    .setIssuedAt(options.iat ?? now);
  if (options.exp !== null) jwt.setExpirationTime(options.exp ?? now + 60);
  if (options.jti !== null) jwt.setJti(options.jti ?? randomUUID());
  return jwt.sign(new TextEncoder().encode(options.secret ?? WEB));
}

describe('service JWT on /internal', () => {
  it('accepts a token from the web app and reports who it acts for', async () => {
    const res = await call(await valid());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: { status: 'ok', issuer: 'web', workspaceId: 'ws-1', subject: 'user-1' },
    });
  });

  it('accepts a token from the AI service signed with its own secret', async () => {
    expect((await call(await valid({ issuer: 'ai', secret: AI }))).status).toBe(200);
  });

  it('refuses a request without a token, and an API key', async () => {
    expect((await call()).status).toBe(401);
    const withKey = await call('qc_sk_0000000000000000000000000000000000000000');
    expect(withKey.status).toBe(401);
    expect(withKey.body).toMatchObject({ success: false, error: { code: 'unauthorized' } });
  });

  it.each([
    ['signed with another secret', () => craft({ secret: 'not-the-secret-not-the-secret-32!' })],
    ['signed with the secret of another issuer', () => craft({ secret: AI })],
    ['from an issuer that may not call the API', () => valid({ issuer: 'worker', secret: WORKER })],
    ['whose key id names another issuer than iss', () => craft({ kid: 'ai', secret: AI })],
    ['for another audience', () => craft({ claims: { aud: 'ai' } })],
    [
      'that has expired',
      () =>
        craft({
          iat: Math.floor(Date.now() / 1000) - 120,
          exp: Math.floor(Date.now() / 1000) - 60,
        }),
    ],
    [
      'that lives longer than 60 seconds',
      () => craft({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    ],
    ['without an expiry', () => craft({ exp: null })],
    ['without a jti', () => craft({ jti: null })],
    ['without a workspace', () => craft({ claims: { workspaceId: undefined } })],
    [
      'with scopes that are not a list of strings',
      () => craft({ claims: { scopes: 'quotes:write' } }),
    ],
    ['signed with HS512', () => craft({ alg: 'HS512' })],
    [
      'with alg none',
      async () => {
        const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
        const now = Math.floor(Date.now() / 1000);
        return `${encode({ alg: 'none', kid: 'web' })}.${encode({ iss: 'web', aud: 'api', workspaceId: 'ws-1', scopes: [], iat: now, exp: now + 60, jti: randomUUID() })}.`;
      },
    ],
  ])('refuses a token %s', async (_name, build) => {
    const res = await call(await build());

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'unauthorized', message: 'A valid service token is required' },
    });
  });

  it('accepts a token once: a replay within its lifetime is refused', async () => {
    const token = await valid();

    expect((await call(token)).status).toBe(200);
    expect((await call(token)).status).toBe(401);
  });

  it('refuses every token when no service secret is configured', async () => {
    const bare = createApp({
      db: {} as Db,
      config: testConfig(),
      replayCache: new MemoryReplayCache(),
    });

    const res = await request(bare)
      .get('/internal/healthz')
      .set('Authorization', `Bearer ${await valid()}`);

    expect(res.status).toBe(401);
  });
});
