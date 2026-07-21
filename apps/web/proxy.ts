import NextAuth from 'next-auth';
import { authConfig } from '@/lib/auth/config';

// Clean secret — Vercel env vars may have literal \n suffix
const secret = (process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || '')
  .replace(/\\n$/g, '').replace(/\n$/g, '').trim();

// A lightweight NextAuth instance for the proxy (Next 16's name for middleware,
// always on the Node.js runtime). It has no database adapter, and the JWT
// callback skips the soft-delete/password-change DB check so this hop, which
// runs on every page request, stays cheap. The full check runs in the main
// auth instance used by server components and server actions.
const { auth } = NextAuth({
  secret,
  session: { strategy: 'jwt' },
  trustHost: process.env.NODE_ENV === 'development' || !!process.env.VERCEL || process.env.AUTH_TRUST_HOST === 'true',
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
      // No DB check here — Edge Runtime cannot import Prisma binary engine.
      // The full JWT callback (with soft-delete + password-change checks) runs
      // in the Node.js auth instance on every server action / server component call.
      return token;
    },
  },
});

export default auth;

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
