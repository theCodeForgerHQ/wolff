/**
 * Error codes the login page receives as `/login?error=<code>`.
 * No server imports: the login form (a client component) reads this too.
 */
export const ACCOUNT_DEACTIVATED_ERROR = 'AccountDeactivated';

const ACCOUNT_DEACTIVATED_MESSAGE =
  'This account has been deactivated, so it can no longer be used to sign in. Contact support if you think this is a mistake.';
const GENERIC_SIGN_IN_MESSAGE = 'Sign-in failed. Please try again.';

/** The message to show for a sign-in error code, or null when there is none. */
export function signInErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return code === ACCOUNT_DEACTIVATED_ERROR ? ACCOUNT_DEACTIVATED_MESSAGE : GENERIC_SIGN_IN_MESSAGE;
}
