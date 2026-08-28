/**
 * Phase 6b: the public API `/api/v1/*` is served by apps/api, which ports the
 * Next routes under `app/api/v1` with the same contract. Where
 * `API_V1_UPSTREAM` is set (the deployed web project), requests are rewritten
 * to `<upstream>/v1/*` before Next matches its own routes; elsewhere (local
 * development, tests) the Next routes still answer.
 *
 * The Next routes stay in the tree for one week after the rewrite went live
 * (Phase 6b), as the fallback an unset variable restores. Deletion
 * date: see docs/phase-6b.md.
 */
export interface Rewrite {
  source: string;
  destination: string;
}

export function apiV1Rewrites(env: Record<string, string | undefined>): Rewrite[] {
  const raw = env.API_V1_UPSTREAM?.trim();
  if (!raw) return [];

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
  return [{ source: '/api/v1/:path*', destination: `${upstream.origin}/v1/:path*` }];
}
