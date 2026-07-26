import { describe, expect, it } from 'vitest';
import { z } from './zod';
import {
  ERROR_STATUS,
  cursorQuerySchema,
  errorEnvelopeSchema,
  pageQuerySchema,
  successEnvelope,
  toPageMeta,
} from './envelope';

describe('pageQuerySchema', () => {
  it('defaults to page 1 with 25 rows, the defaults of the existing /api/v1 lists', () => {
    expect(pageQuerySchema.parse({})).toEqual({ page: 1, limit: 25 });
  });

  it('coerces query-string values', () => {
    expect(pageQuerySchema.parse({ page: '3', limit: '50' })).toEqual({ page: 3, limit: 50 });
  });

  it.each([
    [{ page: '0' }, 'page below 1'],
    [{ page: '-2' }, 'negative page'],
    [{ page: '1.5' }, 'fractional page'],
    [{ page: 'abc' }, 'non-numeric page'],
    [{ limit: '0' }, 'limit below 1'],
    [{ limit: '101' }, 'limit above 100'],
  ])('rejects %j (%s)', (query, _reason) => {
    expect(pageQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe('cursorQuerySchema', () => {
  it('defaults to 50 rows and no cursor', () => {
    expect(cursorQuerySchema.parse({})).toEqual({ limit: 50 });
  });

  it('rejects an empty or oversized cursor', () => {
    expect(cursorQuerySchema.safeParse({ cursor: '' }).success).toBe(false);
    expect(cursorQuerySchema.safeParse({ cursor: 'x'.repeat(513) }).success).toBe(false);
  });
});

describe('toPageMeta', () => {
  it('computes totalPages, including the empty list', () => {
    expect(toPageMeta({ page: 2, limit: 25, total: 51 })).toEqual({
      page: 2,
      limit: 25,
      total: 51,
      totalPages: 3,
    });
    expect(toPageMeta({ page: 1, limit: 25, total: 0 }).totalPages).toBe(0);
  });
});

describe('envelopes', () => {
  it('accepts a success envelope whose data matches', () => {
    const schema = successEnvelope(z.object({ id: z.string() }));

    expect(schema.safeParse({ success: true, data: { id: 'a' } }).success).toBe(true);
    expect(schema.safeParse({ success: true, data: { id: 1 } }).success).toBe(false);
    expect(schema.safeParse({ success: false, data: { id: 'a' } }).success).toBe(false);
  });

  it('accepts only the documented error codes', () => {
    const body = { success: false, error: { code: 'not_found', message: 'Not found' } };

    expect(errorEnvelopeSchema.safeParse(body).success).toBe(true);
    expect(
      errorEnvelopeSchema.safeParse({ ...body, error: { ...body.error, code: 'teapot' } }).success
    ).toBe(false);
  });

  it('maps every error code to the HTTP status in the design', () => {
    expect(ERROR_STATUS).toMatchObject({
      validation_error: 400,
      unauthorized: 401,
      insufficient_scope: 403,
      not_found: 404,
      conflict: 409,
      business_rule: 422,
      gst_unsupported: 422,
      rate_limited: 429,
    });
  });
});
