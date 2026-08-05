import { z } from './zod';

export const paymentProviderSchema = z.enum(['stripe', 'razorpay']).openapi('PaymentProvider');

export const createPaymentLinkSchema = z
  .object({
    provider: paymentProviderSchema.optional(),
  })
  .strict()
  .openapi('CreatePaymentLink');

export type CreatePaymentLinkInput = z.infer<typeof createPaymentLinkSchema>;

export const paymentLinkResponseSchema = z
  .discriminatedUnion('provider', [
    z.object({
      provider: z.literal('stripe'),
      url: z.string().url(),
      sessionId: z.string(),
    }),
    z.object({
      provider: z.literal('razorpay'),
      orderId: z.string(),
      amount: z.number().int(),
      currency: z.string().length(3),
      keyId: z.string(),
      prefill: z.object({
        name: z.string().optional(),
        email: z.string().email().optional(),
        contact: z.string().optional(),
      }),
    }),
  ])
  .openapi('PaymentLinkResponse');

export type PaymentLinkResponse = z.infer<typeof paymentLinkResponseSchema>;
