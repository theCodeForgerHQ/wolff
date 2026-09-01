import { createCipheriv, createDecipheriv, randomBytes, type DecipherGCM } from 'node:crypto';
import { Transform } from 'node:stream';

/**
 * Encryption of database backups before they leave the function (AES-256-GCM).
 *
 * File layout: MAGIC (8 bytes) | IV (12 random bytes) | ciphertext | tag (16).
 * The magic is authenticated as associated data, so a file cannot be passed
 * off as another format version. The key is BACKUP_ENCRYPTION_KEY: 32 random
 * bytes, base64. Without it a backup cannot be read; see docs/runbook.md.
 *
 * GCM checks the tag only at the end, so decrypted bytes stream out before
 * the file is known to be authentic. The restore runs in one transaction and
 * a failed check throws before it commits, so nothing unauthenticated stays.
 */

const MAGIC = Buffer.from('WOLFENC1', 'latin1');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + IV_BYTES;

/** Parses BACKUP_ENCRYPTION_KEY: exactly 32 bytes, base64. */
export function parseBackupKey(value: string): Buffer {
  const trimmed = value.trim();
  const key = Buffer.from(trimmed, 'base64');
  // Buffer.from ignores invalid characters; require the canonical encoding.
  if (key.length !== 32 || key.toString('base64') !== trimmed) {
    throw new Error(
      'BACKUP_ENCRYPTION_KEY must be 32 bytes in base64 (generate one with `openssl rand -base64 32`)'
    );
  }
  return key;
}

export function encryptBackup(key: Buffer): Transform {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(MAGIC);
  let started = false;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      if (!started) {
        started = true;
        this.push(Buffer.concat([MAGIC, iv]));
      }
      done(null, cipher.update(chunk));
    },
    flush(done) {
      if (!started) this.push(Buffer.concat([MAGIC, iv]));
      this.push(cipher.final());
      done(null, cipher.getAuthTag());
    },
  });
}

export function decryptBackup(key: Buffer): Transform {
  let header = Buffer.alloc(0);
  let decipher: DecipherGCM | undefined;
  // The last TAG_BYTES seen so far: they may be the tag, so they are held back.
  let tail = Buffer.alloc(0);

  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      let data = chunk;
      if (!decipher) {
        header = Buffer.concat([header, data]);
        if (header.length < HEADER_BYTES) return done();
        if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
          return done(new Error('Not an encrypted wolff backup (no WOLFENC1 header)'));
        }
        decipher = createDecipheriv(
          'aes-256-gcm',
          key,
          header.subarray(MAGIC.length, HEADER_BYTES)
        );
        decipher.setAAD(MAGIC);
        data = header.subarray(HEADER_BYTES);
      }
      const held = Buffer.concat([tail, data]);
      const cut = Math.max(0, held.length - TAG_BYTES);
      tail = held.subarray(cut);
      done(null, decipher.update(held.subarray(0, cut)));
    },
    flush(done) {
      const prefix = header.subarray(0, MAGIC.length);
      if (!decipher && !MAGIC.subarray(0, prefix.length).equals(prefix)) {
        return done(new Error('Not an encrypted wolff backup (no WOLFENC1 header)'));
      }
      if (!decipher || tail.length < TAG_BYTES) {
        return done(new Error('Encrypted backup is too short to hold its tag'));
      }
      decipher.setAuthTag(tail);
      try {
        done(null, decipher.final());
      } catch {
        done(
          new Error('Backup failed authentication: wrong BACKUP_ENCRYPTION_KEY or a damaged file')
        );
      }
    },
  });
}
