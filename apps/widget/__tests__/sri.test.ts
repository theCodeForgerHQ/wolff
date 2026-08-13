import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM script without types
import { sriHash } from '../scripts/sri.mjs';

describe('sriHash', () => {
  it('is the base64 SHA-384 of the bytes, in the form browsers check', () => {
    const bytes = Buffer.from('console.log("widget")');
    const expected = createHash('sha384').update(bytes).digest('base64');

    expect(sriHash(bytes)).toBe(`sha384-${expected}`);
  });
});
