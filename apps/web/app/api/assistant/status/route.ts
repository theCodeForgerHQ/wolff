import { NextResponse } from 'next/server';
import { aiAvailable } from '@/lib/assistant/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Whether the assistant can be shown; the UI hides it when this is false. */
export async function GET() {
  return NextResponse.json({ available: await aiAvailable() });
}
