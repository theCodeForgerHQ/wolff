import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import { decryptBackup, encryptBackup, parseBackupKey } from './backup-cipher';

const KEY = randomBytes(32);

async function through(
  data: Buffer,
  transform: NodeJS.ReadWriteStream,
  chunk = 7
): Promise<Buffer> {
  const out: Buffer[] = [];
  const pieces = [];
  for (let at = 0; at < data.length; at += chunk) pieces.push(data.subarray(at, at + chunk));
  await pipeline(Readable.from(pieces), transform, async (source) => {
    for await (const piece of source) out.push(piece as Buffer);
  });
  return Buffer.concat(out);
}

describe('backup encryption (AES-256-GCM)', () => {
  const plain = Buffer.from('{"format":"wolff-logical-backup"}\n'.repeat(500));

  it.each([1, 7, 16, 4096])('round-trips in %i-byte chunks', async (chunk) => {
    const sealed = await through(plain, encryptBackup(KEY), chunk);
    expect(await through(sealed, decryptBackup(KEY), chunk)).toEqual(plain);
  });

  it('writes no plaintext, and a fresh IV every time', async () => {
    const a = await through(plain, encryptBackup(KEY));
    const b = await through(plain, encryptBackup(KEY));
    expect(a.includes(Buffer.from('wolff-logical-backup'))).toBe(false);
    expect(a.subarray(0, 8).toString('latin1')).toBe('WOLFENC1');
    expect(a.subarray(8, 20).equals(b.subarray(8, 20))).toBe(false);
  });

  it('refuses the wrong key', async () => {
    const sealed = await through(plain, encryptBackup(KEY));
    await expect(through(sealed, decryptBackup(randomBytes(32)))).rejects.toThrow(
      /wrong BACKUP_ENCRYPTION_KEY or a damaged file/
    );
  });

  it.each([
    ['a flipped ciphertext byte', (b: Buffer) => b.fill(b[100]! ^ 1, 100, 101)],
    ['a flipped tag byte', (b: Buffer) => b.fill(b[b.length - 1]! ^ 1, b.length - 1)],
    ['a missing tail', (b: Buffer) => b.subarray(0, b.length - 5)],
  ])('refuses %s', async (_name, damage) => {
    const sealed = damage(Buffer.from(await through(plain, encryptBackup(KEY))));
    await expect(through(sealed, decryptBackup(KEY))).rejects.toThrow(/damaged file|too short/);
  });

  it('refuses a file that is not an encrypted backup', async () => {
    await expect(through(Buffer.from('\x1f\x8b plain gzip'), decryptBackup(KEY))).rejects.toThrow(
      /Not an encrypted wolff backup/
    );
  });
});

describe('parseBackupKey', () => {
  it('takes 32 bytes as base64', () => {
    expect(parseBackupKey(KEY.toString('base64')).equals(KEY)).toBe(true);
  });

  it.each(['', 'short', randomBytes(16).toString('base64'), randomBytes(33).toString('base64')])(
    'refuses %j',
    (value) => {
      expect(() => parseBackupKey(value)).toThrow(/BACKUP_ENCRYPTION_KEY must be 32 bytes/);
    }
  );
});
