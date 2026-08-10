/**
 * The web app's Content-Security-Policy, in one place. proxy.ts
 * builds it per request with a fresh nonce and sends it on the response;
 * next.config.ts and vercel.json deliberately set none, because a second
 * policy would be enforced as well (browsers apply every CSP they get).
 *
 * Scripts: only the app's own and those carrying the request's nonce run.
 * 'strict-dynamic' lets a nonced script load what it needs (Next's chunks,
 * Stripe.js, Razorpay's checkout.js); the host allowlist is kept for
 * browsers without 'strict-dynamic' support. No 'unsafe-inline', and
 * 'unsafe-eval' only in development, where React's tooling needs it.
 *
 * Styles keep 'unsafe-inline'. Radix, sonner and motion set style
 * attributes at runtime, which a nonce cannot cover (style attributes have
 * no nonce), so removing it would break positioning and animations. Style
 * injection cannot run script, so this is the narrow exception the spec
 * allows.
 */

const STRIPE_JS = 'https://js.stripe.com';
const STRIPE_HOOKS = 'https://hooks.stripe.com';
const STRIPE_API = 'https://api.stripe.com';
const RAZORPAY_CHECKOUT = 'https://checkout.razorpay.com';
const RAZORPAY_API = 'https://api.razorpay.com';
const RAZORPAY_LOGS = 'https://lumberjack.razorpay.com';

export interface CspOptions {
  nonce: string;
  isDev: boolean;
  /** Origin of the Sentry DSN, when the browser SDK is on. */
  sentryOrigin?: string | null;
}

export function buildContentSecurityPolicy({ nonce, isDev, sentryOrigin }: CspOptions): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      STRIPE_JS,
      RAZORPAY_CHECKOUT,
      ...(isDev ? ["'unsafe-eval'"] : []),
    ],
    'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    'img-src': ["'self'", 'data:', 'blob:', 'https:'],
    'font-src': ["'self'", 'https://fonts.gstatic.com'],
    'frame-src': [STRIPE_JS, STRIPE_HOOKS, RAZORPAY_CHECKOUT, RAZORPAY_API],
    'connect-src': [
      "'self'",
      STRIPE_API,
      RAZORPAY_API,
      RAZORPAY_LOGS,
      ...(sentryOrigin ? [sentryOrigin] : []),
      // The dev server's hot reload socket.
      ...(isDev ? ['ws:'] : []),
    ],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}

/** 128 random bits, base64: a new one for every response. */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}
