import { describe, expect, it } from 'vitest';
import { readSseEvents } from '@/lib/assistant/sse';

function stream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks: string[]) {
  const out = [];
  for await (const event of readSseEvents(stream(chunks))) out.push(event);
  return out;
}

describe('readSseEvents', () => {
  it('parses events split across chunks', async () => {
    const events = await collect([
      'event: token\ndata: {"text":"Hel',
      'lo "}\n\nevent: citation\ndata: {"n":1,"source_type":"quote","source_id":"q1","label":"Q-1"}\n',
      '\nevent: done\ndata: {"sessionId":"s1"}\n\n',
    ]);
    expect(events).toEqual([
      { event: 'token', data: { text: 'Hello ' } },
      { event: 'citation', data: { n: 1, source_type: 'quote', source_id: 'q1', label: 'Q-1' } },
      { event: 'done', data: { sessionId: 's1' } },
    ]);
  });

  it('handles CRLF line endings and skips comments and malformed data', async () => {
    const events = await collect([
      ': keep-alive\r\n\r\nevent: token\r\ndata: {"text":"a"}\r\n\r\nevent: token\r\ndata: not-json\r\n\r\n',
    ]);
    expect(events).toEqual([{ event: 'token', data: { text: 'a' } }]);
  });

  it('defaults the event name to message and flushes a final event without a blank line', async () => {
    expect(await collect(['data: {"x":1}'])).toEqual([{ event: 'message', data: { x: 1 } }]);
  });
});
