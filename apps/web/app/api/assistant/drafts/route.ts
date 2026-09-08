import { NextRequest, NextResponse } from 'next/server';
import { validateRequestOrigin } from '@/lib/csrf';
import { z } from 'zod';
import { AssistantUnavailable, callAi } from '@/lib/assistant/proxy';

export const runtime = 'nodejs';

const bodySchema = z.object({
  brief: z.string().trim().min(3).max(4000),
  dealId: z.string().max(100).optional(),
});

/** Asks the AI service's quote agent for a draft. */
export async function POST(request: NextRequest) {
  // Cookie-authenticated, and the body is read whatever its content type:
  // refuse cross-site requests, as the other session routes do.
  if (!validateRequestOrigin(request)) {
    return NextResponse.json({ success: false, error: 'Invalid request origin' }, { status: 403 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Invalid brief' }, { status: 400 });
  }
  try {
    const upstream = await callAi('/drafts', parsed.data, request.signal);
    const payload = await upstream.json().catch(() => ({ success: false }));
    return NextResponse.json(payload, { status: upstream.status });
  } catch (error) {
    if (error instanceof AssistantUnavailable) {
      return NextResponse.json({ success: false, error: error.message }, { status: 503 });
    }
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ success: false, error: 'Assistant unreachable' }, { status: 502 });
  }
}
