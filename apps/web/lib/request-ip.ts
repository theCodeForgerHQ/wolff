/**
 * The client's IP address, for rate limits and audit records.
 *
 * `x-real-ip` first: Vercel and the usual reverse proxies set it themselves
 * and do not pass a client's own through. Otherwise the last
 * `X-Forwarded-For` entry, the one the nearest proxy appended; entries before
 * it are whatever the client sent, so keying a rate limit on the first one
 * let a client choose a new key per request.
 */
export function requestIp(headers: Pick<Headers, 'get'>): string | null {
  const real = headers.get('x-real-ip')?.trim();
  if (real) return real;
  const forwarded = headers
    .get('x-forwarded-for')
    ?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return forwarded?.at(-1) ?? null;
}
