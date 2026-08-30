/**
 * Phase 6b: the public API `/api/v1/*` is served by apps/api, which ports the
 * Next routes under `app/api/v1` with the same contract. Where
 * `API_V1_UPSTREAM` is set (the deployed web project), the proxy (proxy.ts)
 * rewrites requests to `<upstream>/v1/*` before Next matches its own routes;
 * elsewhere (local development, tests) the Next routes still answer.
 *
 * The rewrite is made in the proxy rather than in next.config's rewrites
 * because only the proxy can change the forwarded request's headers: the
 * web app's session cookie is not sent on to the API, which authenticates
 * with API keys alone.
 *
 * The Next routes stay in the tree for one week after the rewrite went live
 * (Phase 6b), as the fallback an unset variable restores. Deletion
 * date: see docs/phase-6b.md.
 */

/** The API's origin, or null when the Next routes answer. Throws on a bad value. */
export function apiV1Upstream(env: Record<string, string | undefined>): string | null {
  const raw = env.API_V1_UPSTREAM?.trim();
  if (!raw) return null;

  let upstream: URL;
  try {
    upstream = new URL(raw);
  } catch {
    throw new Error(`API_V1_UPSTREAM must be an http(s) origin, got "${raw}"`);
  }
  const isOrigin = upstream.pathname === '/' && !upstream.search && !upstream.hash;
  if (!['http:', 'https:'].includes(upstream.protocol) || !isOrigin) {
    throw new Error(`API_V1_UPSTREAM must be an http(s) origin, got "${raw}"`);
  }
  return upstream.origin;
}

const API_V1_PATH = /^\/api\/v1(\/.*)?$/;

/**
 * Where a `/api/v1` request goes on the API and with which headers (all but
 * Cookie), or null for any other path.
 */
export function apiV1Proxy(
  upstream: string,
  url: URL,
  headers: Headers
): { url: URL; headers: Headers } | null {
  const match = API_V1_PATH.exec(url.pathname);
  if (!match) return null;
  const target = new URL(`/v1${match[1] ?? ''}${url.search}`, upstream);
  const forwarded = new Headers(headers);
  forwarded.delete('cookie');
  return { url: target, headers: forwarded };
}
