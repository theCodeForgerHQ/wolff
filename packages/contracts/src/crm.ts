import { z } from './zod';
import { cursorQuerySchema } from './envelope';

export const LEAD_SOURCES = ['manual', 'widget', 'api', 'import'] as const;
export const LEAD_STATUSES = [
  'new',
  'contacted',
  'qualified',
  'disqualified',
  'converted',
] as const;
/** `stages.position` is a Postgres integer. */
export const MAX_STAGE_POSITION = 1_000_000;
/** `deals.value` is numeric(12, 2). */
export const MAX_DEAL_VALUE = 9_999_999_999.99;

export const STAGE_KINDS = ['open', 'won', 'lost'] as const;

export const leadSourceSchema = z.enum(LEAD_SOURCES).openapi('LeadSource');
export const leadStatusSchema = z.enum(LEAD_STATUSES).openapi('LeadStatus');
export const stageKindSchema = z.enum(STAGE_KINDS).openapi('StageKind');

export const createLeadSchema = z
  .object({
    name: z.string().trim().min(1).max(200).openapi({ example: 'Priya Sharma' }),
    email: z.string().trim().email().max(255).optional(),
    phone: z.string().trim().max(30).optional(),
    company: z.string().trim().max(200).optional(),
    source: leadSourceSchema.default('manual'),
    status: leadStatusSchema.default('new'),
    score: z.number().int().min(0).max(100).optional(),
    message: z.string().trim().max(5000).optional(),
    ownerId: z.string().uuid().optional(),
  })
  .strict()
  .openapi('CreateLead');

export type CreateLeadInput = z.infer<typeof createLeadSchema>;

/** An empty form field arrives as "": treat it as absent. */
const optionalText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().max(max).optional()
  );

/**
 * What a visitor may send through the widget (`POST /v1/public/leads`).
 * Only what a contact form asks for; source, status, score and owner are
 * the workspace's to decide, so they are not accepted here.
 */
export const publicLeadSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    email: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z.string().trim().email().max(255).optional()
    ),
    phone: optionalText(30),
    company: optionalText(200),
    message: optionalText(5000),
  })
  .strict()
  .openapi('PublicLead');

export type PublicLeadInput = z.infer<typeof publicLeadSchema>;

export const updateLeadSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    email: z.string().trim().email().max(255).optional().or(z.literal('')),
    phone: z.string().trim().max(30).optional().or(z.literal('')),
    company: z.string().trim().max(200).optional().or(z.literal('')),
    source: leadSourceSchema.optional(),
    status: leadStatusSchema.optional(),
    score: z.number().int().min(0).max(100).optional().nullable(),
    message: z.string().trim().max(5000).optional().or(z.literal('')),
    ownerId: z.string().uuid().optional().nullable(),
  })
  .strict()
  .openapi('UpdateLead');

export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;

export const leadSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    company: z.string().nullable(),
    source: leadSourceSchema,
    status: leadStatusSchema,
    score: z.number().int().nullable(),
    scoreReasons: z.record(z.string(), z.unknown()).nullable(),
    message: z.string().nullable(),
    utm: z.record(z.string(), z.unknown()).nullable(),
    ownerId: z.string().uuid().nullable(),
    clientId: z.string().uuid().nullable(),
    convertedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    deletedAt: z.string().datetime().nullable(),
  })
  .openapi('Lead');

export const leadListQuerySchema = cursorQuerySchema
  .extend({
    status: z.enum(LEAD_STATUSES).optional(),
    source: z.enum(LEAD_SOURCES).optional(),
    ownerId: z.string().uuid().optional(),
    q: z.string().trim().max(200).optional(),
  })
  .openapi('LeadListQuery');

export type LeadListQuery = z.infer<typeof leadListQuerySchema>;

export const bulkLeadActionSchema = z
  .object({
    ids: z.array(z.string().uuid()).min(1).max(500),
    action: z.enum(['assign', 'status', 'delete']),
    value: z.string().max(200).optional(),
  })
  .strict()
  .openapi('BulkLeadAction');

export type BulkLeadActionInput = z.infer<typeof bulkLeadActionSchema>;

export const convertLeadSchema = z
  .object({
    title: z.string().trim().max(200).optional(),
    value: z.number().nonnegative().max(MAX_DEAL_VALUE).optional(),
    currency: z.string().trim().length(3).optional(),
    stageId: z.string().uuid().optional(),
  })
  .strict()
  .openapi('ConvertLead');

export const importLeadRowSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    email: z.string().trim().email().max(255).optional(),
    phone: z.string().trim().max(30).optional(),
    company: z.string().trim().max(200).optional(),
    source: leadSourceSchema.default('import'),
    status: leadStatusSchema.default('new'),
    score: z.number().int().min(0).max(100).optional(),
    message: z.string().trim().max(5000).optional(),
    ownerId: z.string().uuid().optional(),
  })
  .strict()
  .openapi('ImportLeadRow');

export const importLeadsSchema = z
  .object({
    leads: z.array(importLeadRowSchema).min(1).max(1000),
    dedupeBy: z
      .array(z.enum(['email', 'phone']))
      .min(1)
      .max(2)
      .default(['email']),
  })
  .strict()
  .openapi('ImportLeads');

export type ImportLeadsInput = z.infer<typeof importLeadsSchema>;

export const importLeadsResultSchema = z
  .object({
    created: z.number().int(),
    updated: z.number().int(),
    skipped: z.number().int(),
    errors: z.number().int(),
    failures: z.array(z.object({ row: z.number().int(), message: z.string() })),
  })
  .openapi('ImportLeadsResult');

export type ConvertLeadRequest = z.infer<typeof convertLeadSchema>;

export const convertedLeadSchema = z
  .object({
    leadId: z.string().uuid(),
    clientId: z.string().uuid(),
    dealId: z.string().uuid(),
  })
  .openapi('ConvertedLead');

export const stageSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    position: z.number().int(),
    probability: z.number().int(),
    kind: stageKindSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi('Stage');

export const createPipelineSchema = z
  .object({
    name: z.string().trim().min(1).max(100).openapi({ example: 'Sales Pipeline' }),
    stages: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(100),
          position: z.number().int().min(0).max(MAX_STAGE_POSITION),
          probability: z.number().int().min(0).max(100),
          kind: stageKindSchema,
        })
      )
      .min(1)
      .max(20)
      .refine((stages) => new Set(stages.map((s) => s.position)).size === stages.length, {
        message: 'Each stage needs its own position',
      }),
  })
  .strict()
  .openapi('CreatePipeline');

export type CreatePipelineInput = z.infer<typeof createPipelineSchema>;

export const updatePipelineSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    isDefault: z.boolean().optional(),
  })
  .strict()
  .openapi('UpdatePipeline');

export type UpdatePipelineInput = z.infer<typeof updatePipelineSchema>;

export const replaceStagesSchema = z
  .object({
    stages: z
      .array(
        z.object({
          id: z.string().uuid().optional(),
          name: z.string().trim().min(1).max(100),
          position: z.number().int().min(0).max(MAX_STAGE_POSITION),
          probability: z.number().int().min(0).max(100),
          kind: stageKindSchema,
        })
      )
      .min(1)
      .max(20)
      .refine((stages) => new Set(stages.map((s) => s.position)).size === stages.length, {
        message: 'Each stage needs its own position',
      }),
  })
  .strict()
  .openapi('ReplaceStages');

export type ReplaceStagesInput = z.infer<typeof replaceStagesSchema>;

export const pipelineSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    isDefault: z.boolean(),
    stages: z.array(stageSchema),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi('Pipeline');

export const createDealSchema = z
  .object({
    pipelineId: z.string().uuid(),
    stageId: z.string().uuid(),
    clientId: z.string().uuid().optional(),
    leadId: z.string().uuid().optional(),
    title: z.string().trim().min(1).max(200),
    value: z.number().nonnegative().max(MAX_DEAL_VALUE).optional(),
    currency: z.string().trim().length(3).optional(),
    expectedCloseDate: z.string().date().optional(),
    ownerId: z.string().uuid().optional(),
  })
  .strict()
  .openapi('CreateDeal');

export type CreateDealInput = z.infer<typeof createDealSchema>;

export const updateDealSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    stageId: z.string().uuid().optional(),
    value: z.number().nonnegative().max(MAX_DEAL_VALUE).optional(),
    currency: z.string().trim().length(3).optional(),
    expectedCloseDate: z.string().date().optional().nullable(),
    ownerId: z.string().uuid().optional().nullable(),
  })
  .strict()
  .openapi('UpdateDeal');

export type UpdateDealInput = z.infer<typeof updateDealSchema>;

export const moveDealSchema = z
  .object({
    stageId: z.string().uuid(),
    position: z.number().optional(),
    lostReason: z.string().trim().max(2000).optional(),
  })
  .strict()
  .openapi('MoveDeal');

export type MoveDealRequest = z.infer<typeof moveDealSchema>;

export const dealSchema = z
  .object({
    id: z.string().uuid(),
    pipelineId: z.string().uuid(),
    stageId: z.string().uuid(),
    leadId: z.string().uuid().nullable(),
    clientId: z.string().uuid().nullable(),
    title: z.string(),
    value: z.string(),
    currency: z.string(),
    expectedCloseDate: z.string().date().nullable(),
    position: z.number(),
    ownerId: z.string().uuid().nullable(),
    wonAt: z.string().datetime().nullable(),
    lostAt: z.string().datetime().nullable(),
    lostReason: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    deletedAt: z.string().datetime().nullable(),
  })
  .openapi('Deal');

export const dealListQuerySchema = cursorQuerySchema.openapi('DealListQuery');
