import NextAuth from 'next-auth';
import { NextResponse } from 'next/server';
import { authConfig } from '@/lib/auth/config';
import { buildContentSecurityPolicy, createNonce } from '@/lib/security/csp';

// The browser SDK posts events to the DSN's host; allow it only when Sentry is on.
const sentryOrigin = process.env.NEXT_PUBLIC_SENTRY_DSN
  ? new URL(process.env.NEXT_PUBLIC_SENTRY_DSN).origin
  : null;

// Clean secret — Vercel env vars may have literal \n suffix
const secret = (process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || '')
  .replace(/\\n$/g, '')
  .replace(/\n$/g, '')
  .trim();

// A lightweight NextAuth instance for the proxy (Next 16's name for middleware,
// always on the Node.js runtime). It has no database adapter, and the JWT
// callback skips the soft-delete/password-change DB check so this hop, which
// runs on every page request, stays cheap. The full check runs in the main
// auth instance used by server components and server actions.
const { auth } = NextAuth({
  secret,
  session: { strategy: 'jwt' },
  trustHost:
    process.env.NODE_ENV === 'development' ||
    !!process.env.VERCEL ||
    process.env.AUTH_TRUST_HOST === 'true',
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,
    async jwt({ token, user, trigger, session }) {
      if (user) {
        token.id = user.id ?? '';
        token.email = user.email ?? '';
        token.name = user.name ?? '';
        token.avatarUrl = user.avatarUrl;
      }
      if (trigger === 'update' && session) {
        token.name = session.name;
        token.avatarUrl = session.avatarUrl;
      }
      // No DB check here, to keep this per-request hop cheap (see above). The
      // full JWT callback (with soft-delete + password-change checks) runs in
      // the main auth instance on every server action / server component call.
      return token;
    },
  },
});

/**
 * Every page response gets the CSP with a fresh nonce (lib/security/csp.ts).
 * Next reads the nonce from the request's CSP header and puts it on the
 * scripts it renders; the root layout passes `x-nonce` to next-themes for its
 * inline script.
 *
 * With a handler, NextAuth no longer redirects when `authorized` returns
 * false (it only short-circuits on a returned Response), so the redirect to
 * the sign-in page is made here.
 */
export default auth(async (request) => {
  const allowed = await authConfig.callbacks?.authorized?.({ request, auth: request.auth });
  if (allowed === false) {
    const signIn = request.nextUrl.clone();
    signIn.pathname = authConfig.pages?.signIn ?? '/login';
    signIn.search = '';
    signIn.searchParams.set('callbackUrl', request.nextUrl.href);
    return NextResponse.redirect(signIn);
  }

  const nonce = createNonce();
  const policy = buildContentSecurityPolicy({
    nonce,
    isDev: process.env.NODE_ENV === 'development',
    sentryOrigin,
  });
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', policy);
  return response;
});

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api (API routes) — intentionally excluded; API routes handle their own
     *   auth via API-key validation or NextAuth session checks in each handler.
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public files (images, etc.)
     */
    '/((?!api|_next/static|_next/image|favicon.ico|.*\\.png$|.*\\.jpg$|.*\\.svg$).*)',
  ],
};
