'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, ArrowRight, Building2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { updateBusinessProfile } from '@/lib/settings/actions';

const businessSchema = z.object({
  businessName: z.string().min(1, 'Business name is required'),
  email: z.email('Valid email is required'),
  phone: z.string().optional(),
  website: z
    .string()
    .transform((val) => {
      if (val && !val.startsWith('http://') && !val.startsWith('https://')) {
        return `https://${val}`;
      }
      return val;
    })
    .pipe(z.url('Please enter a valid URL'))
    .optional()
    .or(z.literal('')),
  street: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zipCode: z.string().optional(),
  country: z.string().optional(),
});

type BusinessFormData = z.infer<typeof businessSchema>;

interface OnboardingBusinessStepProps {
  onNext: () => void;
  initialComplete?: boolean;
}

export function OnboardingBusinessStep({ onNext, initialComplete }: OnboardingBusinessStepProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<BusinessFormData>({
    resolver: zodResolver(businessSchema),
  });

  const onSubmit = (data: BusinessFormData) => {
    setError(null);
    startTransition(async () => {
      try {
        await updateBusinessProfile({
          businessName: data.businessName,
          email: data.email,
          phone: data.phone || undefined,
          website: data.website || undefined,
          address: {
            street: data.street || '',
            city: data.city || '',
            state: data.state || '',
            postalCode: data.zipCode || '',
            country: data.country || '',
          },
        });

        router.refresh();
        onNext();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save business profile');
      }
    });
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="mb-6 text-center">
        <div className="bg-primary/10 mb-4 inline-flex h-12 w-12 items-center justify-center rounded-full">
          <Building2 className="text-primary h-6 w-6" />
        </div>
        <h3 className="text-lg font-semibold">Tell us about your business</h3>
        <p className="text-muted-foreground text-sm">
          This information will appear on your quotes and invoices
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="businessName">Business Name *</Label>
          <Input id="businessName" {...register('businessName')} placeholder="Your Company Name" />
          {errors.businessName && (
            <p className="text-destructive text-sm">{errors.businessName.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="email">Business Email *</Label>
          <Input
            id="email"
            type="email"
            {...register('email')}
            placeholder="hello@yourcompany.com"
          />
          {errors.email && <p className="text-destructive text-sm">{errors.email.message}</p>}
        </div>

        <div className="space-y-2">
          <Label htmlFor="phone">Phone Number</Label>
          <Input id="phone" {...register('phone')} placeholder="+1 (555) 123-4567" />
        </div>

        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="website">Website</Label>
          <Input id="website" {...register('website')} placeholder="https://yourcompany.com" />
          {errors.website && <p className="text-destructive text-sm">{errors.website.message}</p>}
        </div>

        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="street">Street Address</Label>
          <Textarea id="street" {...register('street')} placeholder="123 Main Street" rows={2} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="city">City</Label>
          <Input id="city" {...register('city')} placeholder="New York" />
        </div>

        <div className="space-y-2">
          <Label htmlFor="state">State/Province</Label>
          <Input id="state" {...register('state')} placeholder="NY" />
        </div>

        <div className="space-y-2">
          <Label htmlFor="zipCode">ZIP/Postal Code</Label>
          <Input id="zipCode" {...register('zipCode')} placeholder="10001" />
        </div>

        <div className="space-y-2">
          <Label htmlFor="country">Country</Label>
          <Input id="country" {...register('country')} placeholder="United States" />
        </div>
      </div>

      {error && <p className="text-destructive text-sm">{error}</p>}

      <div className="flex justify-end pt-4">
        <Button type="submit" disabled={isPending}>
          {isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <ArrowRight className="mr-2 h-4 w-4" />
          )}
          Continue
        </Button>
      </div>
    </form>
  );
}
