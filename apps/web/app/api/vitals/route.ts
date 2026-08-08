import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@wolff/core/logger';
import { z } from 'zod';

const vitalsSchema = z.object({
  name: z.enum(['CLS', 'FCP', 'FID', 'INP', 'LCP', 'TTFB']),
  value: z.number(),
  id: z.string().optional(),
  navigationType: z.string().optional(),
});

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const parsed = vitalsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Invalid vital' }, { status: 400 });
  }

  logger.info(
    { vital: parsed.data.name, value: parsed.data.value, id: parsed.data.id },
    'web-vital'
  );

  return new Response(null, { status: 204 });
}
