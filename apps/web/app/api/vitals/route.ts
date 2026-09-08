import { requestIp } from '@/lib/request-ip';
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@wolff/core/logger';
import { z } from 'zod';
import { checkRateLimit, getRateLimitHeaders } from '@/lib/rate-limit';
import { rateVital } from '@/lib/observability/web-vitals';

/** A page reports a handful of vitals per load; 60 a minute per client is generous. */
const VITALS_LIMIT = { limit: 60, windowMs: 60_000 };

const vitalsSchema = z.object({
  name: z.enum(['CLS', 'FCP', 'FID', 'INP', 'LCP', 'TTFB']),
  value: z.number().finite().nonnegative(),
  id: z.string().optional(),
  navigationType: z.string().optional(),
});

export async function POST(request: NextRequest) {
  // Unauthenticated and written to the logs: cap it so it cannot be used to
  // flood them.
  const clientIp = requestIp(request.headers) || 'unknown';
  const limited = await checkRateLimit(`vitals:${clientIp}`, VITALS_LIMIT);
  if (limited.limited) {
    return NextResponse.json(
      { success: false, error: 'Too many requests' },
      { status: 429, headers: getRateLimitHeaders(limited) }
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = vitalsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Invalid vital' }, { status: 400 });
  }

  logger.info(
    {
      vital: parsed.data.name,
      value: parsed.data.value,
      rating: rateVital(parsed.data.name, parsed.data.value),
      id: parsed.data.id,
    },
    'web-vital'
  );

  return new Response(null, { status: 204 });
}
