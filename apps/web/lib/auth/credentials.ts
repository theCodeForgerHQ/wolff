import { prisma } from '@wolff/database';
import bcrypt from 'bcryptjs';
import { checkRateLimit } from '@/lib/rate-limit';
import { logger, maskEmail } from '@/lib/logger';

const FIFTEEN_MINUTES = 15 * 60 * 1000;

/**
 * Login limits. Per email and address: someone failing to sign in as a person
 * locks out only themselves, not the person signing in from elsewhere. Per
 * address: one client cannot try a password against many accounts. Per email
 * across all addresses, looser: bounds guessing spread over many addresses.
 */
const LOGIN_LIMITS = (email: string, ip: string | null) => [
  { key: `login:${email}:${ip ?? 'unknown'}`, limit: 5, windowMs: FIFTEEN_MINUTES },
  ...(ip ? [{ key: `login-ip:${ip}`, limit: 30, windowMs: FIFTEEN_MINUTES }] : []),
  { key: `login:${email}`, limit: 50, windowMs: 60 * 60 * 1000 },
];

export async function verifyCredentials(email: string, password: string, ip: string | null = null) {
  const normalizedEmail = email.toLowerCase().trim();
  for (const { key, limit, windowMs } of LOGIN_LIMITS(normalizedEmail, ip)) {
    const rateLimitResult = await checkRateLimit(key, { limit, windowMs });
    if (rateLimitResult.limited) {
      throw new Error('Too many login attempts. Please try again in 15 minutes.');
    }
  }

  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: {
      id: true,
      email: true,
      name: true,
      avatarUrl: true,
      passwordHash: true,
      emailVerifiedAt: true,
      deletedAt: true,
    },
  });

  // Bug #84: Reject soft-deleted users — also checked in JWT callback for existing tokens
  if (!user || user.deletedAt) {
    logger.warn({ email: maskEmail(normalizedEmail) }, '[auth] Authentication failed');
    return null;
  }

  if (!user.passwordHash) {
    // User signed up with OAuth, doesn't have a password
    logger.warn({ email: maskEmail(normalizedEmail) }, '[auth] Authentication failed');
    return null;
  }

  const isValid = await bcrypt.compare(password, user.passwordHash);

  if (!isValid) {
    logger.warn({ email: maskEmail(normalizedEmail) }, '[auth] Authentication failed');
    return null;
  }

  // Bug #17: Enforce email verification before allowing login
  // Use dedicated env var instead of NODE_ENV (Vercel previews may use NODE_ENV=development)
  const skipVerification =
    process.env.SKIP_EMAIL_VERIFICATION === 'true' && process.env.NODE_ENV !== 'production';
  if (!user.emailVerifiedAt && !skipVerification) {
    throw new Error(
      'Please verify your email before logging in. Check your inbox for a verification link.'
    );
  }

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
  };
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}
