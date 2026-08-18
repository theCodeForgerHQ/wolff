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

  it('schedules the nightly sweep at 01:30 UTC', () => {
    expect(SCHEDULES['ai-sweep']).toEqual({ type: 'ai.sweep', pattern: '30 1 * * *' });
  });
});

describe('ai processors', () => {
  const ai = (): AiIndexer & { calls: unknown[] } => {
    const calls: unknown[] = [];
    return {
      calls,
      index: async (input) => void calls.push(['index', input]),
      sweep: async (ws) => void calls.push(['sweep', ws]),
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
    const ctx = { ai: port, db: { $unscoped: { workspace: { findMany } } } };
    await processors['ai.sweep'](ctx as unknown as JobContext, {});
    expect(findMany).toHaveBeenCalledWith({ where: { deletedAt: null }, select: { id: true } });
    expect(port.calls).toEqual([
      ['sweep', 'w1'],
      ['sweep', 'w2'],
    ]);
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
});
