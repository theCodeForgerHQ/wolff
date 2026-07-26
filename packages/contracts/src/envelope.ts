import { z } from './zod';

/**
 * The response envelope of the public API:
 * `{ success, data?, error?: { code, message, details? }, meta? }`.
 */
export const ERROR_STATUS = {
  validation_error: 400,
  unauthorized: 401,
  insufficient_scope: 403,
  not_found: 404,
  conflict: 409,
  business_rule: 422,
  gst_unsupported: 422,
  rate_limited: 429,
  internal_error: 500,
  not_configured: 501,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export const ERROR_CODES = Object.keys(ERROR_STATUS) as [ErrorCode, ...ErrorCode[]];

export const apiErrorSchema = z
  .object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: z.record(z.string(), z.array(z.string())).optional(),
  })
  .openapi('ApiError');

export type ApiError = z.infer<typeof apiErrorSchema>;

export const errorEnvelopeSchema = z
  .object({
    success: z.literal(false),
    error: apiErrorSchema,
  })
  .openapi('ErrorResponse');

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

/** `?page=&limit=` on the list endpoints that exist today. */
export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type PageQuery = z.infer<typeof pageQuerySchema>;

export const pageMetaSchema = z
  .object({
    page: z.number().int(),
    limit: z.number().int(),
    total: z.number().int(),
    totalPages: z.number().int(),
  })
  .openapi('PageMeta');

export type PageMeta = z.infer<typeof pageMetaSchema>;

export function toPageMeta(input: { page: number; limit: number; total: number }): PageMeta {
  return { ...input, totalPages: Math.ceil(input.total / input.limit) };
}

/** `?limit=&cursor=` on list endpoints added from Phase 2 on. */
export const cursorQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(512).optional(),
});

export type CursorQuery = z.infer<typeof cursorQuerySchema>;

export const cursorMetaSchema = z
  .object({
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  })
  .openapi('CursorMeta');

export type CursorMeta = z.infer<typeof cursorMetaSchema>;

export function successEnvelope<T extends z.ZodType>(data: T) {
  return z.object({ success: z.literal(true), data });
}

export function pagedEnvelope<T extends z.ZodType>(item: T) {
  return z.object({ success: z.literal(true), data: z.array(item), meta: pageMetaSchema });
}

export function cursorEnvelope<T extends z.ZodType>(item: T) {
  return z.object({ success: z.literal(true), data: z.array(item), meta: cursorMetaSchema });
}
