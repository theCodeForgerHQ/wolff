import { requestIp } from '@/lib/request-ip';
import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey } from '@wolff/core/auth/api-keys';
import { coreDb } from '@/lib/core-db';
import { checkRateLimit, getRateLimitHeaders, defaultRateLimitOptions } from '@/lib/rate-limit';

export interface ApiContext {
  workspaceId: string;
  apiKeyId: string;
}

/**
 * Authenticate an API request using Bearer token.
 * Returns workspace context or an error response.
 */
export async function authenticateApiRequest(
  request: NextRequest
): Promise<{ context: ApiContext } | { error: NextResponse }> {
  // Rate limit by IP
  const clientIp = requestIp(request.headers) || 'unknown';
  const rateLimitResult = await checkRateLimit(`api:${clientIp}`, defaultRateLimitOptions);

  if (rateLimitResult.limited) {
    return {
      error: NextResponse.json(
        { error: 'Too many requests. Please try again later.' },
        { status: 429, headers: getRateLimitHeaders(rateLimitResult) }
      ),
    };
  }

  // Extract Bearer token
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return {
      error: NextResponse.json(
        { error: 'Missing or invalid Authorization header. Use: Bearer <api_key>' },
        { status: 401 }
      ),
    };
  }

  const result = await authenticateApiKey(coreDb, authHeader.slice(7));
  if (!result.ok || result.key.kind !== 'secret') {
    const message =
      !result.ok && result.reason === 'malformed'
        ? 'Invalid API key format'
        : !result.ok && result.reason === 'expired'
          ? 'API key has expired'
          : 'Invalid or revoked API key';
    return { error: NextResponse.json({ error: message }, { status: 401 }) };
  }
  const apiKey = result.key;

  return {
    context: {
      workspaceId: apiKey.workspaceId,
      apiKeyId: apiKey.id,
    },
  };
}

/**
 * Helper to create standard JSON responses with consistent format.
 */
export function apiSuccess(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export function apiError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}
