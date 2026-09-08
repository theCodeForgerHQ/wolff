// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';

const workspace = vi.hoisted(() => vi.fn());
vi.mock('@/lib/workspace/get-current-workspace', () => ({ getCurrentUserWorkspace: workspace }));

import { POST as chat } from '@/app/api/assistant/chat/route';
import { POST as drafts } from '@/app/api/assistant/drafts/route';
import { GET as status } from '@/app/api/assistant/status/route';
import { resetAiHealthCache } from '@/lib/assistant/proxy';

const SECRET = 'w'.repeat(64);
const req = (path: string, body: unknown, origin = 'http://localhost:3000') =>
  new NextRequest(`http://app.test${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { origin },
  });

describe('assistant routes', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubEnv('AI_URL', 'http://ai.test/');
    vi.stubEnv('SVC_JWT_SECRET_WEB', SECRET);
    vi.stubGlobal('fetch', fetchMock);
    workspace.mockResolvedValue({ userId: 'u1', workspaceId: 'ws1', role: 'member' });
    resetAiHealthCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('relays the event stream with a token for the session user and workspace', async () => {
    fetchMock.mockResolvedValue(
      new Response('event: done\ndata: {}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      })
    );
    const res = await chat(req('/api/assistant/chat', { message: 'hi', sessionId: 's1' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await res.text()).toContain('event: done');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://ai.test/chat/stream');
    expect(JSON.parse(init.body)).toEqual({ message: 'hi', sessionId: 's1' });
    const token = init.headers.authorization.replace('Bearer ', '');
    const { payload } = await jwtVerify(token, new TextEncoder().encode(SECRET), {
      issuer: 'web',
      audience: 'ai',
    });
    expect(payload).toMatchObject({ sub: 'u1', workspaceId: 'ws1' });
  });

  it('never takes a workspace from the body', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));
    await chat(req('/api/assistant/chat', { message: 'hi', workspaceId: 'other' }));
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init.body)).toEqual({ message: 'hi' });
  });

  it('answers 401 without a session, 400 for a bad body and 503 when not configured', async () => {
    workspace.mockRejectedValueOnce(new Error('Unauthorized'));
    expect((await chat(req('/api/assistant/chat', { message: 'hi' }))).status).toBe(401);
    expect((await chat(req('/api/assistant/chat', { message: '' }))).status).toBe(400);
    vi.stubEnv('AI_URL', '');
    expect((await chat(req('/api/assistant/chat', { message: 'hi' }))).status).toBe(503);
    expect((await drafts(req('/api/assistant/drafts', { brief: 'logo' }))).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes the draft result and its status through', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ success: false, error: { code: 'unknown_client' } }, { status: 422 })
    );
    const res = await drafts(req('/api/assistant/drafts', { brief: 'Draft a quote for X' }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: 'unknown_client' } });
  });

  it('reports the assistant unavailable when the AI service is down or unset', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await (await status()).json()).toEqual({ available: false });
    resetAiHealthCache();
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    expect(await (await status()).json()).toEqual({ available: true });
    resetAiHealthCache();
    vi.stubEnv('SVC_JWT_SECRET_WEB', '');
    expect(await (await status()).json()).toEqual({ available: false });
  });

  // The body is parsed whatever its content type, so a cross-site form post
  // (text/plain, no preflight) could run a turn, or draft a quote, as the
  // signed-in user.
  it('refuses a request from another site before calling the AI service', async () => {
    for (const [route, path] of [
      [chat, '/api/assistant/chat'],
      [drafts, '/api/assistant/drafts'],
    ] as const) {
      const res = await route(req(path, { message: 'hi' }, 'https://evil.example'));
      expect(res.status).toBe(403);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
