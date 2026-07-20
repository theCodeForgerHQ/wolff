const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Parses a test-only service override (a mock Stripe API, a mock OIDC issuer)
 * and refuses anything that isn't http(s) on a loopback host, so a
 * misconfigured deployment can't send secrets to, or trust tokens from,
 * another machine.
 */
export function parseLoopbackUrl(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must use http or https`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`${name} must point at a loopback host`);
  }
  return url;
}
