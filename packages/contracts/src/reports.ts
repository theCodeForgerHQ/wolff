import { z } from './zod';

export const ageingBucketSchema = z.enum([
  'current',
  'bucket_0_30',
  'bucket_31_60',
  'bucket_61_90',
  'bucket_90_plus',
]);

export const receivablesAgeingRowSchema = z.object({
  invoiceId: z.string(),
  clientId: z.string(),
  invoiceNumber: z.string(),
  currency: z.string(),
  total: z.number(),
  amountDue: z.number(),
  dueDate: z.string().datetime(),
  daysOverdue: z.number(),
  bucket: ageingBucketSchema,
});

export const revenueMonthlyRowSchema = z.object({
  month: z.string().datetime(),
  currency: z.string(),
  revenue: z.number(),
  paymentCount: z.number(),
});

export const gstOutwardSupplyRowSchema = z.object({
  invoiceId: z.string(),
  invoiceNumber: z.string(),
  issueDate: z.string().datetime(),
  supplyType: z.string(),
  reverseCharge: z.boolean(),
  supplierGstin: z.string().nullable(),
  recipientGstin: z.string().nullable(),
  hsnSac: z.string().nullable(),
  gstRate: z.number().nullable(),
  taxableValue: z.number(),
  cgstAmount: z.number(),
  sgstAmount: z.number(),
  igstAmount: z.number(),
  cessAmount: z.number(),
  lineTotal: z.number(),
});

export const pipelineStageRowSchema = z.object({
  dealId: z.string(),
  title: z.string(),
  value: z.number(),
  currency: z.string(),
  pipelineId: z.string(),
  pipelineName: z.string(),
  stageId: z.string(),
  stageName: z.string(),
  stagePosition: z.number(),
  stageKind: z.string(),
  probability: z.number(),
  leadId: z.string().nullable(),
  clientId: z.string().nullable(),
  ownerId: z.string().nullable(),
  expectedCloseDate: z.string().datetime().nullable(),
  dealCreatedAt: z.string().datetime(),
  wonAt: z.string().datetime().nullable(),
  lostAt: z.string().datetime().nullable(),
});
