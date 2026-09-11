'use client';

import { useState, useTransition, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Loader2,
  ArrowRight,
  ArrowLeft,
  CreditCard,
  ExternalLink,
  CheckCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { createStripeOnboardingLink, checkStripeAccountStatus } from '@/lib/payments/actions';

interface OnboardingPaymentStepProps {
  onNext: () => void;
  onSkip: () => void;
  onBack: () => void;
  stripeEnabled: boolean;
}

export function OnboardingPaymentStep({
  onNext,
  onSkip,
  onBack,
  stripeEnabled,
}: OnboardingPaymentStepProps) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [stripeConnected, setStripeConnected] = useState(false);
  const [verifying, startVerifying] = useTransition();
  const searchParams = useSearchParams();

  // Bug #10: Verify Stripe account status after returning from Stripe onboarding
  useEffect(() => {
    const stripeParam = searchParams.get('stripe');
    if (stripeParam === 'success') {
      // A transition rather than a loading flag, so nothing is set
      // synchronously inside the effect.
      startVerifying(async () => {
        try {
          const status = await checkStripeAccountStatus();
          if (status.chargesEnabled && status.payoutsEnabled) {
            setStripeConnected(true);
          } else if (status.connected) {
            setError('Stripe setup is incomplete. Please complete all required steps in Stripe.');
          }
        } catch {
          setError('Failed to verify Stripe connection');
        }
      });
    }
  }, [searchParams]);

  const handleConnectStripe = () => {
    setError(null);
    startTransition(async () => {
      try {
        // Bug #10: Return to onboarding after Stripe setup
        const result = await createStripeOnboardingLink({ returnTo: 'onboarding' });
        if (result.success && result.url) {
          window.location.href = result.url;
        } else {
          setError(result.error || 'Failed to create Stripe connection');
        }
      } catch {
        setError('An unexpected error occurred');
      }
    });
  };

  return (
    <div className="space-y-6">
      <div className="mb-6 text-center">
        <div className="bg-primary/10 mb-4 inline-flex h-12 w-12 items-center justify-center rounded-full">
          <CreditCard className="text-primary h-6 w-6" />
        </div>
        <h3 className="text-lg font-semibold">Accept online payments</h3>
        <p className="text-muted-foreground text-sm">
          Connect with Stripe to accept credit card payments from your clients
        </p>
      </div>

      {stripeEnabled ? (
        <div className="space-y-6">
          {verifying ? (
            <div className="space-y-4 rounded-lg border p-6 text-center">
              <Loader2 className="text-primary mx-auto h-8 w-8 animate-spin" />
              <p className="text-muted-foreground text-sm">Verifying Stripe connection...</p>
            </div>
          ) : stripeConnected ? (
            <div className="space-y-4 rounded-lg border border-green-200 bg-green-50 p-6 text-center dark:border-green-800 dark:bg-green-950">
              <div className="mb-2 inline-flex h-16 w-16 items-center justify-center rounded-full bg-green-100 dark:bg-green-900">
                <CheckCircle className="h-8 w-8 text-green-600 dark:text-green-400" />
              </div>
              <h4 className="font-semibold text-green-700 dark:text-green-300">
                Stripe Connected!
              </h4>
              <p className="text-sm text-green-600 dark:text-green-400">
                Your Stripe account is verified and ready to accept payments.
              </p>
              <Button onClick={onNext} className="mt-4">
                Continue
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          ) : (
            <div className="space-y-4 rounded-lg border p-6 text-center">
              <div className="mb-2 inline-flex h-16 w-16 items-center justify-center rounded-full bg-violet-100">
                <svg className="h-8 w-8 text-violet-600" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.591-7.305z" />
                </svg>
              </div>
              <h4 className="font-semibold">Connect with Stripe</h4>
              <p className="text-muted-foreground mx-auto max-w-md text-sm">
                Stripe is the industry standard for secure payment processing. You&apos;ll be
                redirected to Stripe to complete the setup.
              </p>
              <ul className="mx-auto max-w-sm space-y-2 text-left text-sm">
                <li className="flex items-center gap-2">
                  <CheckCircle className="h-4 w-4 text-green-600" />
                  Accept credit and debit cards
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle className="h-4 w-4 text-green-600" />
                  Get paid directly to your bank
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle className="h-4 w-4 text-green-600" />
                  Automatic payment receipts
                </li>
              </ul>
              <Button onClick={handleConnectStripe} disabled={isPending} className="mt-4">
                {isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <ExternalLink className="mr-2 h-4 w-4" />
                )}
                Connect with Stripe
              </Button>
            </div>
          )}

          {error && <p className="text-destructive text-center text-sm">{error}</p>}

          <p className="text-muted-foreground text-center text-sm">
            You can skip this step and set up payments later in Settings
          </p>
        </div>
      ) : (
        <div className="bg-muted/50 space-y-4 rounded-lg border p-6 text-center">
          <h4 className="font-semibold">Stripe Not Configured</h4>
          <p className="text-muted-foreground mx-auto max-w-md text-sm">
            Online payment processing requires Stripe API keys to be configured. You can set this up
            later by adding your Stripe keys to the environment variables.
          </p>
        </div>
      )}

      <div className="flex justify-between pt-4">
        <Button type="button" variant="ghost" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <Button type="button" variant="outline" onClick={onSkip}>
          Skip for now
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
