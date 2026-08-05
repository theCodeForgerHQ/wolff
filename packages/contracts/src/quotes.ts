import { z } from './zod';

export const createQuoteFromDealSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    expirationDate: z.string().date().optional(),
  })
  .strict()
  .openapi('CreateQuoteFromDeal');

export type CreateQuoteFromDealInput = z.infer<typeof createQuoteFromDealSchema>;

export const quoteFromDealSchema = z
  .object({
    quoteId: z.string().uuid(),
    quoteNumber: z.string(),
  })
  .openapi('QuoteFromDeal');
