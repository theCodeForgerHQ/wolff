/**
 * The client's IP address, for rate limits and audit records. Only what the
 * hosting itself sets is trusted; headers a client sends are not.
 *
 * - On Vercel (VERCEL=1) the edge sets `x-real-ip` and overwrites
 *   `X-Forwarded-For`, so `x-real-ip` is the client.
 * - Elsewhere the app is expected behind TRUSTED_PROXY_HOPS reverse proxies
 *   (default 1: the Traefik of the Docker setup), each appending the address
 *   it saw to `X-Forwarded-For`. The client is the entry that many from the
 *   right; entries before it, and `x-real-ip`, are whatever the client sent.
 *   The web port must then be reachable only through that proxy.
 */
export function requestIp(
  headers: Pick<Headers, 'get'>,
  env: Record<string, string | undefined> = process.env
): string | null {
  if (env.VERCEL === '1') {
    const real = headers.get('x-real-ip')?.trim();
    if (real) return real;
  }
  const hops = Math.max(1, Number(env.TRUSTED_PROXY_HOPS ?? 1) || 1);
  const forwarded = (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return forwarded[forwarded.length - hops] ?? null;
}
