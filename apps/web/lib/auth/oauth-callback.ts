/**
 * Auth.js (v5, @auth/core handle-login) links an OAuth account to whoever the
 * request's session cookie belongs to: if a session exists when the provider
 * redirects back, `linkAccount` attaches the new Google/GitHub identity to
 * that session's user, without comparing emails. On the demo, a browser still
 * signed in as the shared demo user (a 7-day JWT) turned every Google sign-in
 * into "link this Google account to demo@...", which gives whoever owns that
 * Google account a permanent login to the shared demo user, and leaves the
 * person without their own account.
 *
 * Wolff has no "connect another login to my account" feature, so an OAuth
 * callback is always treated as a fresh sign-in: the session cookies are
 * removed from the callback request before Auth.js sees it. Auth.js then
 * either signs in the user already linked to that provider account, creates a
 * new user and workspace, or refuses with OAuthAccountNotLinked when another
 * user has the same email. The new session cookie it sets replaces the old
 * one, so the previous session is signed out.
 */
import { NextRequest } from 'next/server';

const OAUTH_CALLBACK = /^\/api\/auth\/callback\/([^/]+)\/?$/;
// authjs.session-token, __Secure-/__Host- prefixed, and chunked .0, .1, ...
const SESSION_COOKIE = /^(?:__Secure-|__Host-)?(?:authjs|next-auth)\.session-token(?:\.\d+)?$/;

export function withoutSessionOnOAuthCallback(request: NextRequest): NextRequest {
  const match = OAUTH_CALLBACK.exec(request.nextUrl.pathname);
  if (!match || match[1] === 'credentials') return request;

  const cookies = request.cookies.getAll();
  const kept = cookies.filter((cookie) => !SESSION_COOKIE.test(cookie.name));
  if (kept.length === cookies.length) return request;

  const headers = new Headers(request.headers);
  if (kept.length === 0) headers.delete('cookie');
  else
    headers.set('cookie', kept.map((c) => `${c.name}=${encodeURIComponent(c.value)}`).join('; '));

  return new NextRequest(request.url, {
    method: request.method,
    headers,
    ...(request.method !== 'GET' &&
      request.method !== 'HEAD' && {
        body: request.body,
        duplex: 'half',
      }),
  });
}
