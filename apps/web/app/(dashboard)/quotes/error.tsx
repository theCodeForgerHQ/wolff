'use client';

import { useEffect } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Low #80: Route-level error boundary — sidebar and header stay visible
export default function QuotesError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Quotes section error:', error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <AlertTriangle className="text-destructive mb-4 h-10 w-10" />
      <h2 className="mb-2 text-lg font-semibold">Something went wrong</h2>
      <p className="text-muted-foreground mb-6 max-w-md text-sm">
        {process.env.NODE_ENV === 'development'
          ? error.message
          : 'An error occurred loading this page.'}
      </p>
      {error.digest && (
        <p className="text-muted-foreground mb-4 text-xs">Reference: {error.digest}</p>
      )}
      <Button onClick={reset}>
        <RefreshCw className="mr-2 h-4 w-4" />
        Try again
      </Button>
    </div>
  );
}
