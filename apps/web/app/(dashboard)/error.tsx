'use client';

import { useEffect } from 'react';
import { AlertTriangle, RefreshCw, Home } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log the error to an error reporting service
    console.error('Dashboard error:', error);
  }, [error]);

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <Card className="max-w-md">
        <CardHeader className="text-center">
          <div className="bg-destructive/10 mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full">
            <AlertTriangle className="text-destructive h-6 w-6" />
          </div>
          <CardTitle>Something went wrong</CardTitle>
          <CardDescription>We encountered an unexpected error. Please try again.</CardDescription>
        </CardHeader>
        {/* Low #73: Only show error details in development to prevent info leakage */}
        <CardContent>
          <div className="bg-muted rounded-md p-3">
            <p className="text-muted-foreground break-all font-mono text-sm">
              {process.env.NODE_ENV === 'development'
                ? error.message || 'An unknown error occurred'
                : 'An unexpected error occurred. Please try again or contact support.'}
            </p>
            {error.digest && (
              <p className="text-muted-foreground mt-2 text-xs">Reference: {error.digest}</p>
            )}
          </div>
        </CardContent>
        <CardFooter className="flex justify-center gap-2">
          <Button variant="outline" asChild>
            {/* A full reload, so the page that crashed starts clean. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/">
              <Home className="mr-2 h-4 w-4" />
              Go Home
            </a>
          </Button>
          <Button onClick={reset}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Try again
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
