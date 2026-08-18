import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import type { AiIndexer } from '../types';

const TOKEN_TTL_SECONDS = 60;

/**
 * Calls the AI service's indexing endpoints with a worker service JWT
 * (iss=worker, aud=ai, 60 s, scope ai:index, kid=worker). A
 * non-2xx answer throws, so the job retries.
 */
export function createAiIndexer(options: {
  baseUrl: string;
  secret: string;
  fetch?: typeof fetch;
}): AiIndexer {
  const send = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/$/, '');

  async function token(workspaceId: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ workspaceId, scopes: ['ai:index'] })
      .setProtectedHeader({ alg: 'HS256', kid: 'worker' })
      .setIssuer('worker')
      .setAudience('ai')
      .setIssuedAt(now)
      .setExpirationTime(now + TOKEN_TTL_SECONDS)
      .setJti(randomUUID())
      .sign(new TextEncoder().encode(options.secret));
  }

  async function post(path: string, workspaceId: string, body?: unknown): Promise<void> {
    const response = await send(`${base}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await token(workspaceId)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`AI service ${path} answered ${response.status}`);
  }

  return {
    index: ({ workspaceId, sourceType, sourceId }) =>
      post('/ingest', workspaceId, { sourceType, sourceId }),
    sweep: (workspaceId) => post('/ingest/sweep', workspaceId),
  };
}
