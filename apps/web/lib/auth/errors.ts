/**
 * Error codes the login page receives as `/login?error=<code>`.
 * No server imports: the login form (a client component) reads this too.
 */
export const ACCOUNT_DEACTIVATED_ERROR = 'AccountDeactivated';

const ACCOUNT_DEACTIVATED_MESSAGE =
  'This account has been deactivated, so it can no longer be used to sign in. Contact support if you think this is a mistake.';
/** Auth.js's code when an OAuth email belongs to a user it may not link to. */
export const OAUTH_ACCOUNT_NOT_LINKED_ERROR = 'OAuthAccountNotLinked';
const OAUTH_ACCOUNT_NOT_LINKED_MESSAGE =
  'This email already has an account. Sign in the way you signed up: with your email and password, or with the other provider.';
const GENERIC_SIGN_IN_MESSAGE = 'Sign-in failed. Please try again.';

/** The message to show for a sign-in error code, or null when there is none. */
export function signInErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  if (code === ACCOUNT_DEACTIVATED_ERROR) return ACCOUNT_DEACTIVATED_MESSAGE;
  if (code === OAUTH_ACCOUNT_NOT_LINKED_ERROR) return OAUTH_ACCOUNT_NOT_LINKED_MESSAGE;
  return GENERIC_SIGN_IN_MESSAGE;
}
