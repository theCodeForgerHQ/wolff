import { getBaseUrl } from '@/lib/utils';
import { NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { z } from 'zod';
import { prisma } from '@wolff/database';
import { hashPassword } from '@/lib/auth/credentials';
import { createUserWithWorkspace } from '@/lib/auth/provision-user';
import { checkRateLimit, getRateLimitHeaders, strictRateLimitOptions } from '@/lib/rate-limit';
import { passwordSchema } from '@/lib/validations/auth';
import { validateRequestOrigin } from '@/lib/csrf';
import { logger, maskEmail, maskIp } from '@/lib/logger';

const registerSchema = z.object({
  name: z.string().min(2),
  email: z.email(),
  password: passwordSchema,
  termsAccepted: z.literal(true, { error: 'You must accept the terms and conditions' }),
});

export async function POST(request: Request) {
  try {
    // Bug #14: CSRF origin validation
    if (!validateRequestOrigin(request)) {
      return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 });
    }

    const clientIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const rateLimitResult = await checkRateLimit(`register:${clientIp}`, strictRateLimitOptions);
    if (rateLimitResult.limited) {
      return NextResponse.json(
        { error: 'Too many registration attempts. Please try again later.' },
        { status: 429, headers: getRateLimitHeaders(rateLimitResult) }
      );
    }

    const body = await request.json();
    const parsed = registerSchema.parse(body);
    const name = parsed.name;
    const email = parsed.email.toLowerCase();
    const password = parsed.password;

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    // Bug #47: Always hash password to prevent timing-based email enumeration
    // bcrypt runs regardless of whether user exists, normalizing response time
    const passwordHash = await hashPassword(password);

    if (existingUser) {
      return NextResponse.json(
        { error: 'Unable to create account. Please try again.' },
        { status: 400 }
      );
    }

    // The user, their workspace and the owner membership, in one transaction
    const result = await createUserWithWorkspace(prisma, { name, email, passwordHash });

    // Create email verification token and send email
    let emailSent = false;
    try {
      const rawToken = crypto.randomUUID();
      const tokenHash = createHash('sha256').update(rawToken).digest('hex');
      const tokenExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

      await prisma.emailVerificationToken.create({
        data: {
          userId: result.id,
          token: tokenHash, // Store hash, not raw token
          expiresAt: tokenExpiresAt,
        },
      });

      const { sendVerificationEmail } = await import('@/lib/services/email');
      const baseUrl = getBaseUrl();
      const verifyUrl = `${baseUrl}/verify-email/confirm?token=${rawToken}`; // Email gets raw token
      const emailResult = await sendVerificationEmail({ to: email, name, verifyUrl });
      emailSent = emailResult.success;

      if (!emailSent) {
        throw new Error(emailResult.error || 'Verification email was not sent');
      }
    } catch (emailError) {
      // The account stays unverified. Verifying it here would hand a verified
      // account for this address to whoever registered it, without proof that
      // they own it. /verify-email offers "Resend verification email".
      emailSent = false;
      logger.error({ err: emailError }, 'Failed to send verification email');
    }

    // Bug #72: Audit log for new account creation
    logger.info(
      { userId: result.id, email: maskEmail(result.email), ip: maskIp(clientIp) },
      '[AUDIT] New account registered'
    );

    return NextResponse.json(
      {
        user: { id: result.id, name: result.name, email: result.email },
        message: emailSent
          ? 'Account created. Please check your email to verify your account.'
          : 'Account created, but the verification email could not be sent. Use "Resend verification email" to try again.',
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      // Return user-friendly messages without exposing internal schema details
      const messages = error.issues.map((e) => e.message);
      return NextResponse.json({ error: 'Invalid request data', messages }, { status: 400 });
    }

    logger.error({ err: error }, 'Registration error');
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
