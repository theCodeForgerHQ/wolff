'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Loader2, Mail, CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function VerifyEmailPage() {
  // useSearchParams needs a Suspense boundary to prerender.
  return (
    <Suspense>
      <VerifyEmail />
    </Suspense>
  );
}

function VerifyEmail() {
  // Sign-up redirects here with the address. An unverified user has no
  // session, so the resend route needs it in the body.
  const [email, setEmail] = useState(useSearchParams().get('email') ?? '');
  const [isResending, setIsResending] = useState(false);
  const [resent, setResent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleResend = async () => {
    setIsResending(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        setResent(true);
      } else {
        setError(data.error || 'Failed to resend');
      }
    } catch {
      setError('Failed to resend verification email');
    } finally {
      setIsResending(false);
    }
  };

  // Low #69: Removed min-h-screen — AuthLayout already handles centering
  return (
    <div className="flex items-center justify-center">
      <div className="mx-auto max-w-md space-y-6 p-8 text-center">
        <div className="flex justify-center">
          <div className="bg-primary/10 flex h-16 w-16 items-center justify-center rounded-full">
            <Mail className="text-primary h-8 w-8" />
          </div>
        </div>

        <div className="space-y-2">
          <h1 className="text-2xl font-bold">Check your email</h1>
          <p className="text-muted-foreground">
            We sent you a verification link. Please check your inbox and click the link to verify
            your email address.
          </p>
        </div>

        {resent ? (
          <div className="flex items-center justify-center gap-2 text-green-600">
            <CheckCircle className="h-4 w-4" />
            <p className="text-sm">Verification email sent!</p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1 text-left">
              <Label htmlFor="resend-email">Email</Label>
              <Input
                id="resend-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            {error && <p className="text-destructive text-sm">{error}</p>}
            <Button
              variant="outline"
              onClick={handleResend}
              disabled={isResending || !email.trim()}
            >
              {isResending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Resend verification email
            </Button>
          </div>
        )}

        <p className="text-muted-foreground text-sm">
          <Link href="/login" className="text-primary hover:underline">
            Back to login
          </Link>
        </p>
      </div>
    </div>
  );
}
