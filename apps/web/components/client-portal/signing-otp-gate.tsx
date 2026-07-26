'use client';

import { useState, useTransition } from 'react';
import { Mail, Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { sendSigningOtp, verifySigningOtpAction } from '@/lib/signing/actions';
import { toast } from 'sonner';

interface SigningOtpGateProps {
  type: 'quote' | 'contract';
  accessToken: string;
  clientEmail: string;
  onVerified: () => void;
}

/**
 * Email OTP verification gate shown before the signature pad.
 * The signer must verify their email before they can sign.
 */
export function SigningOtpGate({
  type,
  accessToken,
  clientEmail,
  onVerified,
}: SigningOtpGateProps) {
  const [step, setStep] = useState<'request' | 'verify'>('request');
  const [code, setCode] = useState('');
  const [isPending, startTransition] = useTransition();

  // Mask email for display: a***@example.com
  const maskedEmail = clientEmail.replace(
    /^(.{1,2})(.*)(@.*)$/,
    (_, start, middle, domain) => `${start}${'*'.repeat(Math.min(middle.length, 5))}${domain}`
  );

  // CR #18: Wrap in try/catch to handle network failures — useTransition won't catch them
  const handleSendOtp = () => {
    startTransition(async () => {
      try {
        const result = await sendSigningOtp({ type, accessToken });
        if (result.success) {
          toast.success('Verification code sent to your email');
          setStep('verify');
        } else {
          toast.error(result.error);
        }
      } catch {
        toast.error('Network error. Please check your connection and try again.');
      }
    });
  };

  const handleVerifyOtp = () => {
    if (code.length !== 6) {
      toast.error('Please enter the 6-digit code');
      return;
    }

    startTransition(async () => {
      try {
        const result = await verifySigningOtpAction({
          type,
          accessToken,
          code: code.trim(),
          email: clientEmail,
        });
        if (result.success) {
          toast.success('Identity verified');
          onVerified();
        } else {
          toast.error(result.error);
        }
      } catch {
        toast.error('Network error. Please check your connection and try again.');
      }
    });
  };

  const handleResend = () => {
    setCode('');
    handleSendOtp();
  };

  if (step === 'request') {
    return (
      <Card>
        <CardHeader className="text-center">
          <div className="bg-primary/10 mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full">
            <ShieldCheck className="text-primary h-6 w-6" />
          </div>
          <CardTitle>Verify Your Identity</CardTitle>
          <CardDescription>
            Before signing, we need to verify your identity. We&apos;ll send a verification code to{' '}
            <strong>{maskedEmail}</strong>.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center">
          <Button onClick={handleSendOtp} disabled={isPending}>
            {isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Sending...
              </>
            ) : (
              <>
                <Mail className="mr-2 h-4 w-4" />
                Send Verification Code
              </>
            )}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="text-center">
        <div className="bg-primary/10 mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full">
          <Mail className="text-primary h-6 w-6" />
        </div>
        <CardTitle>Enter Verification Code</CardTitle>
        <CardDescription>
          We sent a 6-digit code to <strong>{maskedEmail}</strong>. Check your inbox and enter it
          below.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="mx-auto max-w-xs space-y-2">
          <Label htmlFor="otp-code">Verification Code</Label>
          <Input
            id="otp-code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="000000"
            className="text-center font-mono text-2xl tracking-widest"
            maxLength={6}
            autoFocus
            disabled={isPending}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && code.length === 6) {
                handleVerifyOtp();
              }
            }}
          />
        </div>

        <div className="flex flex-col items-center gap-2">
          <Button onClick={handleVerifyOtp} disabled={isPending || code.length !== 6}>
            {isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Verifying...
              </>
            ) : (
              <>
                <ShieldCheck className="mr-2 h-4 w-4" />
                Verify
              </>
            )}
          </Button>

          <button
            type="button"
            onClick={handleResend}
            disabled={isPending}
            className="text-muted-foreground hover:text-foreground text-sm transition-colors"
          >
            Didn&apos;t receive the code? Resend
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
