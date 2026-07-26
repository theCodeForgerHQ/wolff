import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decrypt, encrypt, isEncryptionEnabled } from './encryption';

const KEY = 'ab'.repeat(32);

describe('encryption', () => {
  const original = process.env.ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = KEY;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = original;
  });

  it('round-trips a secret and does not store it in the clear', () => {
    const stored = encrypt('whsec_live_secret');

    expect(stored.startsWith('enc:')).toBe(true);
    expect(stored).not.toContain('whsec_live_secret');
    expect(decrypt(stored)).toBe('whsec_live_secret');
  });

  it('uses a fresh IV, so equal secrets encrypt differently', () => {
    expect(encrypt('same')).not.toBe(encrypt('same'));
  });

  it('returns legacy plaintext values unchanged', () => {
    expect(decrypt('whsec_plain_legacy')).toBe('whsec_plain_legacy');
  });

  it('rejects a ciphertext that was modified', () => {
    const [iv, tag, data] = encrypt('secret').slice('enc:'.length).split(':') as [
      string,
      string,
      string,
    ];
    const flipped = Buffer.from(data, 'base64');
    flipped[0] = flipped[0]! ^ 0xff;

    expect(() => decrypt(`enc:${iv}:${tag}:${flipped.toString('base64')}`)).toThrow();
  });

  it('rejects a ciphertext encrypted under another key', () => {
    const stored = encrypt('secret');
    process.env.ENCRYPTION_KEY = 'cd'.repeat(32);

    expect(() => decrypt(stored)).toThrow();
  });

  it('is disabled, and stores plaintext, when the key is missing or the wrong length', () => {
    delete process.env.ENCRYPTION_KEY;
    expect(isEncryptionEnabled()).toBe(false);
    expect(encrypt('secret')).toBe('secret');

    process.env.ENCRYPTION_KEY = 'abcd';
    expect(isEncryptionEnabled()).toBe(false);
  });
});
