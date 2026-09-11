import { describe, expect, it } from 'vitest';
import { demoId } from './demo-id';

describe('demoId', () => {
  it('is a valid RFC 9562 UUID, the same every time for the same name', () => {
    const id = demoId('client-1');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(demoId('client-1')).toBe(id);
  });

  it('differs between names', () => {
    expect(demoId('client-1')).not.toBe(demoId('client-2'));
  });
});
