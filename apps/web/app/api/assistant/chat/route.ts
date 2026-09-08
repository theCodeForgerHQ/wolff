import { NextRequest, NextResponse } from 'next/server';
import { validateRequestOrigin } from '@/lib/csrf';
import { z } from 'zod';
import { AssistantUnavailable, callAi } from '@/lib/assistant/proxy';

export const runtime = 'nodejs';

const bodySchema = z.object({
  message: z.string().trim().min(1).max(4000),
  sessionId: z.string().max(100).optional(),
});

/**
 * Streams one assistant turn: authenticates the session, mints
 * a 60 s service JWT and relays the AI service's server-sent events.
 */
export async function POST(request: NextRequest) {
  // Cookie-authenticated, and the body is read whatever its content type:
  // refuse cross-site requests, as the other session routes do.
  if (!validateRequestOrigin(request)) {
    return NextResponse.json({ success: false, error: 'Invalid request origin' }, { status: 403 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Invalid message' }, { status: 400 });
  }
  let upstream: Response;
  try {
    upstream = await callAi('/chat/stream', parsed.data, request.signal);
  } catch (error) {
    if (error instanceof AssistantUnavailable) {
      return NextResponse.json({ success: false, error: error.message }, { status: 503 });
    }
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ success: false, error: 'Assistant unreachable' }, { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json(
      { success: false, error: 'Assistant error' },
      { status: upstream.status === 429 ? 429 : 502 }
    );
  }
  return new Response(upstream.body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}
