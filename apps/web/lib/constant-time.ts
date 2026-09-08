import { createHash, timingSafeEqual } from 'crypto';

/**
 * Compares two secrets without leaking, through timing, how much of a guess
 * was right. Both sides are hashed first, so their lengths never differ.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(a), digest(b)) && a.length === b.length;
}
