import { describe, expect, it, vi } from 'vitest';
import { jwtVerify } from 'jose';
import { createAiIndexer } from './ports/ai';
import { jobForOutboxEvent } from './routing';
import { processors } from './processors';
import { SCHEDULES } from './bullmq';
import type { AiIndexer, JobContext } from './types';

const SECRET = 'k'.repeat(64);

describe('ai.index routing', () => {
  it('turns an ai.index outbox event into an ai.index job in the row workspace', () => {
    const job = jobForOutboxEvent({
      id: 'evt-1',
      workspaceId: 'ws-row',
      type: 'ai.index',
      aggregateType: 'quote',
      aggregateId: 'q-1',
      payload: { sourceType: 'quote', sourceId: 'q-1', workspaceId: 'ws-forged' },
      traceId: null,
      attempts: 0,
    });
    expect(job).toMatchObject({
      type: 'ai.index',
      jobId: 'outbox:evt-1',
      payload: { workspaceId: 'ws-row', sourceType: 'quote', sourceId: 'q-1' },
    });
  });

  it('rejects an unknown source type', () => {
    const job = jobForOutboxEvent({
      id: 'evt-2',
      workspaceId: 'ws',
      type: 'ai.index',
      aggregateType: 'x',
      aggregateId: 'y',
      payload: { sourceType: 'payment', sourceId: 'p' },
      traceId: null,
      attempts: 0,
    });
    expect(job).toBeNull();
  });

  it('schedules the nightly sweep at 01:30 UTC and reports at 20:30 UTC (02:00 IST)', () => {
    expect(SCHEDULES['ai-sweep']).toEqual({ type: 'ai.sweep', pattern: '30 1 * * *' });
    expect(SCHEDULES['reports-nightly']).toEqual({
      type: 'reports.nightly',
      pattern: '30 20 * * *',
    });
  });
});

describe('ai processors', () => {
  const ai = (): AiIndexer & { calls: unknown[] } => {
    const calls: unknown[] = [];
    return {
      calls,
      index: async (input) => void calls.push(['index', input]),
      sweep: async (ws) => {
        calls.push(['sweep', ws]);
        return { more: false };
      },
      nightlyReport: async (ws) => void calls.push(['report', ws]),
    };
  };

  it('does nothing without an AI service', async () => {
    await expect(
      processors['ai.index']({} as JobContext, {
        workspaceId: 'ws',
        sourceType: 'quote',
        sourceId: 'q',
      })
    ).resolves.toBeUndefined();
  });

  it('indexes through the AI service', async () => {
    const port = ai();
    const input = { workspaceId: 'ws', sourceType: 'invoice' as const, sourceId: 'i' };
    await processors['ai.index']({ ai: port } as unknown as JobContext, input);
    expect(port.calls).toEqual([['index', input]]);
  });

  it('sweeps each live workspace with its own call', async () => {
    const port = ai();
    const findMany = vi.fn().mockResolvedValue([{ id: 'w1' }, { id: 'w2' }]);
    const ctx = {
      ai: port,
      db: { $unscoped: { workspace: { findMany } } },
      now: () => new Date(0),
    };
    await processors['ai.sweep'](ctx as unknown as JobContext, {});
    expect(findMany).toHaveBeenCalledWith({ where: { deletedAt: null }, select: { id: true } });
    expect(port.calls).toEqual([
      ['sweep', 'w1'],
      ['sweep', 'w2'],
    ]);
  });
});

describe('ai.sweep in bounded batches', () => {
  function setup(backlog: Record<string, number>, msPerCall: number) {
    let clock = 0;
    const calls: string[] = [];
    const left = { ...backlog };
    const port = {
      index: async () => undefined,
      nightlyReport: async () => undefined,
      sweep: async (ws: string) => {
        calls.push(ws);
        clock += msPerCall;
        left[ws] = Math.max(0, (left[ws] ?? 0) - 1);
        return { more: left[ws]! > 0 };
      },
    };
    const findMany = vi.fn().mockResolvedValue(Object.keys(backlog).map((id) => ({ id })));
    const ctx = {
      ai: port,
      db: { $unscoped: { workspace: { findMany } } },
      now: () => new Date(clock),
    };
    return { ctx: ctx as unknown as JobContext, calls, left };
  }

  it('calls again while a workspace has more, taking workspaces in turns', async () => {
    const { ctx, calls, left } = setup({ w1: 3, w2: 1, w3: 2 }, 1_000);
    await processors['ai.sweep'](ctx, {});
    expect(calls).toEqual(['w1', 'w2', 'w3', 'w1', 'w3', 'w1']);
    expect(left).toEqual({ w1: 0, w2: 0, w3: 0 });
  });

  it('stops at its time budget and leaves the rest for the next run', async () => {
    const { ctx, calls, left } = setup({ w1: 1_000, w2: 1_000 }, 30_000);
    await processors['ai.sweep'](ctx, {});
    // 30 s per call, so a 200 s budget allows 7 calls: well inside Vercel's 300 s.
    expect(calls).toHaveLength(7);
    expect(left.w1! + left.w2!).toBe(2_000 - 7);
  });
});

describe('reports.nightly', () => {
  it('asks for one report per live workspace', async () => {
    const calls: unknown[] = [];
    const port = {
      index: async () => undefined,
      sweep: async () => ({ more: false }),
      nightlyReport: async (ws: string) => void calls.push(ws),
    };
    const findMany = vi.fn().mockResolvedValue([{ id: 'w1' }, { id: 'w2' }]);
    const ctx = { ai: port, db: { $unscoped: { workspace: { findMany } } } };
    await processors['reports.nightly'](ctx as unknown as JobContext, {});
    expect(calls).toEqual(['w1', 'w2']);
  });

  it('posts with scope reports:run only', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    await createAiIndexer({ baseUrl: 'http://ai', secret: SECRET, fetch }).nightlyReport('ws-9');
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('http://ai/internal/reports/nightly');
    const { payload } = await jwtVerify(
      init.headers.authorization.replace('Bearer ', ''),
      new TextEncoder().encode(SECRET),
      { issuer: 'worker', audience: 'ai' }
    );
    expect(payload).toMatchObject({ workspaceId: 'ws-9', scopes: ['reports:run'] });
  });
});

describe('createAiIndexer', () => {
  it('posts with a worker JWT for the workspace, aud=ai, scope ai:index', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const indexer = createAiIndexer({ baseUrl: 'http://ai/', secret: SECRET, fetch });
    await indexer.index({ workspaceId: 'ws-1', sourceType: 'quote', sourceId: 'q-1' });

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('http://ai/ingest');
    expect(JSON.parse(init.body)).toEqual({ sourceType: 'quote', sourceId: 'q-1' });
    const token = init.headers.authorization.replace('Bearer ', '');
    const { payload, protectedHeader } = await jwtVerify(token, new TextEncoder().encode(SECRET), {
      issuer: 'worker',
      audience: 'ai',
    });
    expect(protectedHeader.kid).toBe('worker');
    expect(payload).toMatchObject({ workspaceId: 'ws-1', scopes: ['ai:index'] });
    expect(payload.exp! - payload.iat!).toBe(60);
    expect(typeof payload.jti).toBe('string');
  });

  it('throws on an error answer so the job retries', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('no', { status: 503 }));
    const indexer = createAiIndexer({ baseUrl: 'http://ai', secret: SECRET, fetch });
    await expect(indexer.sweep('ws')).rejects.toThrow('/ingest/sweep answered 503');
  });

  it('reads whether the sweep has more left', async () => {
    const answer = (more: unknown) =>
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { more } }), { status: 200 }));
    const sweep = (fetch: typeof globalThis.fetch) =>
      createAiIndexer({ baseUrl: 'http://ai', secret: SECRET, fetch }).sweep('ws');
    await expect(sweep(answer(true))).resolves.toEqual({ more: true });
    await expect(sweep(answer(false))).resolves.toEqual({ more: false });
    await expect(sweep(answer('yes'))).resolves.toEqual({ more: false });
  });
});
