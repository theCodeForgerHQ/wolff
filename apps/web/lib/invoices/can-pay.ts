export interface OnlinePaymentContext {
  status: string;
  amountDue: number;
  stripeOnboardingComplete: boolean | null | undefined;
  /** NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY; without it the browser can't load Stripe.js. */
  publishableKey: string | undefined;
}

/**
 * Whether the portal should show the Pay button: the invoice is open, the
 * workspace finished Stripe onboarding, and the deployment has the key the
 * payment form needs.
 */
export function canPayOnline(context: OnlinePaymentContext): boolean {
  const { status, amountDue, stripeOnboardingComplete, publishableKey } = context;
  return (
    status !== 'paid' &&
    status !== 'voided' &&
    amountDue > 0 &&
    !!stripeOnboardingComplete &&
    !!publishableKey
  );
}
