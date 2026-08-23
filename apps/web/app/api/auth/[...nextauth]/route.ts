import type { NextRequest } from 'next/server';
import { handlers } from '@/lib/auth';
import { withoutSessionOnOAuthCallback } from '@/lib/auth/oauth-callback';

export const dynamic = 'force-dynamic';

// OAuth callbacks never see the current session, so Auth.js can't link a new
// provider account to whoever is signed in (lib/auth/oauth-callback.ts).
export function GET(request: NextRequest) {
  return handlers.GET(withoutSessionOnOAuthCallback(request));
}

export function POST(request: NextRequest) {
  return handlers.POST(withoutSessionOnOAuthCallback(request));
}
