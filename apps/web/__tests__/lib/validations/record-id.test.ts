import { describe, expect, it } from 'vitest';
import { isRecordId } from '@/lib/validations/record-id';

describe('isRecordId', () => {
  it('accepts UUIDs and the seeded demo ids', () => {
    expect(isRecordId('3f2b8c1e-9a4d-4e2f-8b7a-1c2d3e4f5a6b')).toBe(true);
    // The demo data uses readable ids; its detail pages answered 404.
    expect(isRecordId('demo-client-1')).toBe(true);
    expect(isRecordId('demo-invoice-5')).toBe(true);
  });

  it('refuses anything that is not a plain id', () => {
    for (const bad of [
      '',
      '../etc/passwd',
      'a b',
      "1' OR '1'='1",
      'x'.repeat(65),
      '-starts-with-dash',
    ]) {
      expect(isRecordId(bad)).toBe(false);
    }
  });
});
