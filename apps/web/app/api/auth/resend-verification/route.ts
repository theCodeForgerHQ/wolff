import { getBaseUrl } from '@/lib/utils';
import { NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { prisma } from '@wolff/database';
import { checkRateLimit, getRateLimitHeaders } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { validateRequestOrigin } from '@/lib/csrf';

const SENT = { success: true, message: 'Verification email sent' };

export async function POST(request: Request) {
  try {
    // Bug #50: CSRF origin validation
    if (!validateRequestOrigin(request)) {
      return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 });
    }

    // Bug #46: Accept email in body so unverified users (who can't get a session) can resend
    const body = await request.json().catch(() => ({}));
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : null;

    if (!email) {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 });
    }

    // Rate limit by IP (shared networks get some room), then by address so one
    // inbox cannot be flooded.
    const clientIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const limits: [string, number][] = [
      [`resend-verification:ip:${clientIp}`, 10],
      [`resend-verification:${email}`, 3],
    ];
    for (const [key, limit] of limits) {
      const rateLimitResult = await checkRateLimit(key, { limit, windowMs: 15 * 60 * 1000 });
      if (rateLimitResult.limited) {
        return NextResponse.json(
          { error: 'Too many requests. Please try again later.' },
          { status: 429, headers: getRateLimitHeaders(rateLimitResult) }
        );
      }
    }

    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, name: true, emailVerifiedAt: true },
    });

    // The route is unauthenticated, so an unknown or already verified address
    // gets the same answer as a real send: it must not reveal which accounts
    // exist.
    if (!user || user.emailVerifiedAt) {
      return NextResponse.json(SENT);
    }

    // Delete existing unused tokens for this user
    await prisma.emailVerificationToken.deleteMany({
      where: { userId: user.id, usedAt: null },
    });

    // Create new token (store hash, send raw)
    const rawToken = crypto.randomUUID();
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    await prisma.emailVerificationToken.create({
      data: {
        userId: user.id,
        token: tokenHash,
        expiresAt,
      },
    });

    // Send verification email
    try {
      const { sendVerificationEmail } = await import('@/lib/services/email');
      const baseUrl = getBaseUrl();
      const verifyUrl = `${baseUrl}/verify-email/confirm?token=${rawToken}`;
      const sent = await sendVerificationEmail({
        to: user.email,
        name: user.name || 'there',
        verifyUrl,
      });
      // It reports a failed send in its result rather than throwing.
      if (!sent.success) throw new Error(sent.error || 'Verification email was not sent');
    } catch (emailError) {
      logger.error({ err: emailError }, 'Failed to send verification email');
      return NextResponse.json({ error: 'Failed to send verification email' }, { status: 500 });
    }

    return NextResponse.json(SENT);
  } catch (error) {
    logger.error({ err: error }, 'Resend verification error');
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
