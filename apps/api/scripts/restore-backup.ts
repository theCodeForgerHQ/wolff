/**
 * Restores a nightly database backup (db.backup) into an empty database
 * that already has the schema, and compares row counts per table with the
 * counts recorded in the backup. See docs/runbook.md "Restore".
 *
 *   RESTORE_TARGET_URL=postgresql://...  BACKUP_BUCKET=backups  BACKUP_ENCRYPTION_KEY=...
 *   STORAGE_ENDPOINT=...
 *   STORAGE_REGION=...  STORAGE_ACCESS_KEY=...  STORAGE_SECRET_KEY=...
 *   pnpm --filter @wolff/api backup:restore [db/2026-08-30.ndjson.gz.enc]
 *
 * Without a key it takes the newest backup. Exits 1 when any count differs.
 */
import { Transform } from 'node:stream';
import { createPrisma } from '@wolff/database';
import { BACKUP_PREFIX, restoreDatabase } from '@wolff/jobs/backup';
import { parseBackupKey } from '@wolff/jobs/backup-cipher';
import { createS3BackupStore } from '@wolff/jobs/ports';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<number> {
  const store = createS3BackupStore({
    bucket: required('BACKUP_BUCKET'),
    region: process.env.STORAGE_REGION ?? 'us-east-1',
    endpoint: required('STORAGE_ENDPOINT'),
    accessKeyId: required('STORAGE_ACCESS_KEY'),
    secretAccessKey: required('STORAGE_SECRET_KEY'),
  });
  const target = required('RESTORE_TARGET_URL');
  const secret = parseBackupKey(required('BACKUP_ENCRYPTION_KEY'));

  let key = process.argv[2];
  if (!key) {
    const files = await store.list(BACKUP_PREFIX);
    files.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
    key = files[0]?.key;
    if (!key) throw new Error(`No backups under ${BACKUP_PREFIX}`);
  }

  const t0 = performance.now();
  // Downloaded and loaded as one stream; count the bytes on the way through.
  // (A 'data' listener on the download would start it flowing before the
  // restore reads it, and drop chunks.)
  let bytes = 0;
  const download = await store.get(key);
  const body = download.pipe(
    new Transform({
      transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length;
        done(null, chunk);
      },
    })
  );
  download.on('error', (error) => body.destroy(error));
  const db = createPrisma(target);
  try {
    const { header, restored } = await db.$transaction((tx) => restoreDatabase(tx, body, secret), {
      maxWait: 30_000,
      timeout: 15 * 60_000,
    });
    const t1 = performance.now();

    const expected = new Map(header.tables.map((table) => [table.name, table.rows]));
    let mismatches = 0;
    console.log(`backup ${key} (${bytes} bytes, taken ${header.createdAt})`);
    console.log('table\tbackup\trestored');
    for (const { name, rows } of restored) {
      const flag = rows === expected.get(name) ? '' : '\tMISMATCH';
      if (flag) mismatches++;
      console.log(`${name}\t${expected.get(name)}\t${rows}${flag}`);
    }
    const total = restored.reduce((sum, table) => sum + table.rows, 0);
    console.log(
      `tables ${restored.length}, rows ${total}, mismatches ${mismatches}; ` +
        `download and load ${((t1 - t0) / 1000).toFixed(1)} s`
    );
    return mismatches === 0 ? 0 : 1;
  } finally {
    await db.$disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
);
