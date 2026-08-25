/**
 * A short in-memory cache for the public widget's CORS origin check. Every
 * unauthenticated preflight on /v1/public used to run an api_keys query;
 * a page polling the widget, or anyone sending preflights with made-up
 * origins, turned straight into database load. Both answers are cached
 * (negative ones too, so random origins cannot bypass it); failed lookups
 * are not. A revoked key's origin can keep passing the preflight for up to
 * the TTL, which is harmless: the request itself is still held to a live
 * key and its origins by requirePublishableKey.
 */
export const ORIGIN_CACHE_TTL_MS = 30_000;
export const ORIGIN_CACHE_MAX_ENTRIES = 1_000;

export function cachedOriginCheck(
  check: (origin: string) => Promise<boolean>,
  {
    ttlMs = ORIGIN_CACHE_TTL_MS,
    maxEntries = ORIGIN_CACHE_MAX_ENTRIES,
    now = Date.now,
  }: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}
): (origin: string) => Promise<boolean> {
  const entries = new Map<string, { ok: boolean; expires: number }>();
  return async (origin) => {
    const hit = entries.get(origin);
    if (hit && hit.expires > now()) return hit.ok;
    entries.delete(origin);
    const ok = await check(origin);
    // Map keeps insertion order: the first key is the oldest entry.
    if (entries.size >= maxEntries) entries.delete(entries.keys().next().value!);
    entries.set(origin, { ok, expires: now() + ttlMs });
    return ok;
  };
}
