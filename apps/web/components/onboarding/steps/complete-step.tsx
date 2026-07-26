'use client';

import { Loader2, PartyPopper, FileText, Users, Rocket } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface OnboardingCompleteStepProps {
  onComplete: () => void;
  isLoading: boolean;
}

export function OnboardingCompleteStep({ onComplete, isLoading }: OnboardingCompleteStepProps) {
  return (
    <div className="space-y-6 text-center">
      <div className="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
        <PartyPopper className="h-8 w-8 text-green-600" />
      </div>

      <div>
        <h3 className="mb-2 text-xl font-semibold">You&apos;re all set!</h3>
        <p className="text-muted-foreground">
          Your account is ready. Here are some things you can do next:
        </p>
      </div>

      <div className="grid gap-4 text-left sm:grid-cols-2">
        <div className="hover:bg-muted/50 rounded-lg border p-4 transition-colors">
          <FileText className="text-primary mb-2 h-5 w-5" />
          <h4 className="font-medium">Create your first quote</h4>
          <p className="text-muted-foreground text-sm">
            Build a professional quote with our visual editor
          </p>
        </div>

        <div className="hover:bg-muted/50 rounded-lg border p-4 transition-colors">
          <Users className="text-primary mb-2 h-5 w-5" />
          <h4 className="font-medium">Add your clients</h4>
          <p className="text-muted-foreground text-sm">
            Import or create client profiles to get started
          </p>
        </div>

        <div className="hover:bg-muted/50 rounded-lg border p-4 transition-colors">
          <Rocket className="text-primary mb-2 h-5 w-5" />
          <h4 className="font-medium">Explore the dashboard</h4>
          <p className="text-muted-foreground text-sm">
            Get insights into your quotes and invoices
          </p>
        </div>
      </div>

      <Button onClick={onComplete} size="lg" disabled={isLoading} className="mt-4">
        {isLoading ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Rocket className="mr-2 h-4 w-4" />
        )}
        Go to Dashboard
      </Button>
    </div>
  );
}
