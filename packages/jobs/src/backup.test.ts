import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { decryptBackup, encryptBackup } from './backup-cipher';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrisma, withTenantGuard } from '@wolff/database';
import { runJob, type JobContext } from './index';
import {
  BackupBudgetError,
  backupKey,
  pruneBackups,
  readBackup,
  restoreDatabase,
  writeBackup,
  type BackupStore,
  type ExportOptions,
  type SqlRunner,
} from './backup';

function memoryStore(files: { key: string; lastModified: Date }[]): BackupStore & {
  deleted: string[];
} {
  const deleted: string[] = [];
  return {
    deleted,
    put: async () => undefined,
    get: async () => Readable.from([]),
    list: async (prefix) => files.filter((file) => file.key.startsWith(prefix)),
    delete: async (key) => {
      deleted.push(key);
    },
  };
}

describe('backupKey', () => {
  it('names one sortable file per UTC day under db/', () => {
    expect(backupKey(new Date('2026-10-08T23:59:59.999Z'))).toBe('db/2026-10-08.ndjson.gz.enc');
  });
});

describe('pruneBackups', () => {
  const NOW = new Date('2026-10-20T00:00:00Z');
  const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

  it('deletes files older than the retention and keeps the rest', async () => {
    const store = memoryStore([
      { key: 'db/a', lastModified: daysAgo(1) },
      { key: 'db/b', lastModified: daysAgo(13) },
      { key: 'db/c', lastModified: daysAgo(15) },
      { key: 'db/d', lastModified: daysAgo(30) },
      { key: 'other/e', lastModified: daysAgo(30) },
    ]);

    expect(await pruneBackups(store, NOW, 14)).toEqual(['db/c', 'db/d']);
    expect(store.deleted).toEqual(['db/c', 'db/d']);
  });

  it('never deletes the newest backup, however old', async () => {
    const store = memoryStore([
      { key: 'db/old', lastModified: daysAgo(40) },
      { key: 'db/newest', lastModified: daysAgo(20) },
    ]);

    expect(await pruneBackups(store, NOW, 14)).toEqual(['db/old']);
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses a retention of %s days', async (days) => {
    await expect(pruneBackups(memoryStore([]), NOW, days)).rejects.toThrow(/keepDays/);
  });
});

describe('readBackup', () => {
  it('refuses a file that is not a backup', async () => {
    const { gzipSync } = await import('node:zlib');
    expect(() => readBackup(gzipSync(Buffer.from('{"format":"other"}\n')))).toThrow(/format/);
  });
});

const url = process.env.TEST_DATABASE_URL;

const KEY = randomBytes(32);

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * Runs writeBackup with an upload that keeps the bytes in memory. `body` is
 * the decrypted gzip, for inspecting; `sealed` is what was uploaded.
 */
async function exportBuffer(sql: SqlRunner, options: ExportOptions) {
  let sealed: Buffer = Buffer.alloc(0);
  const { header } = await writeBackup(
    sql,
    options,
    async (stream) => {
      sealed = await collect(stream);
    },
    KEY
  );
  const body = await collect(Readable.from([sealed]).pipe(decryptBackup(KEY)));
  return { body, sealed, header };
}

describe.skipIf(!url)('export and restore (Postgres)', () => {
  const db = createPrisma(url);
  const schema = `backup_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const parent = `"${schema}"."parent"`;
  const child = `"${schema}"."child"`;
  const exclude = [`${schema}.chunks`];
  const exportSnapshot = (options: ExportOptions) =>
    db.$transaction((tx) => exportBuffer(tx, options), { isolationLevel: 'RepeatableRead' });
  /** Restores a decrypted gzip body: encrypts it, as the store would hold it. */
  const restore = async (body: Uint8Array, key = KEY) => {
    const sealed = await collect(Readable.from([body]).pipe(encryptBackup(KEY)));
    return db.$transaction((tx) => restoreDatabase(tx, Readable.from([sealed]), key));
  };

  const snapshot = async () => ({
    parents: await db.$queryRawUnsafe<unknown[]>(`SELECT * FROM ${parent} ORDER BY id`),
    children: await db.$queryRawUnsafe<unknown[]>(
      `SELECT id, parent_id, prev_id, note, amount, meta, raw, at, embedding::text AS embedding
         FROM ${child} ORDER BY id`
    ),
  });

  beforeAll(async () => {
    await db.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS vector`);
    await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    // `child` sorts before `parent`, so a restore in name order would break
    // the foreign key; `prev_id` references its own table.
    await db.$executeRawUnsafe(`CREATE TABLE ${parent} (id int PRIMARY KEY, name text NOT NULL)`);
    await db.$executeRawUnsafe(
      `CREATE TABLE ${child} (
         id int PRIMARY KEY,
         parent_id int NOT NULL REFERENCES ${parent}(id),
         prev_id int REFERENCES ${child}(id),
         note text, amount numeric(12,2), meta jsonb, raw bytea,
         at timestamptz, embedding halfvec(3))`
    );
    await db.$executeRawUnsafe(
      `INSERT INTO ${parent} SELECT g, 'p' || g FROM generate_series(1, 7) g`
    );
    // Migration history, as a freshly migrated target database has it too.
    await db.$executeRawUnsafe(
      `CREATE TABLE "${schema}"."_prisma_migrations" (id text PRIMARY KEY)`
    );
    await db.$executeRawUnsafe(`INSERT INTO "${schema}"."_prisma_migrations" VALUES ('0001_init')`);
    await db.$executeRawUnsafe(
      `CREATE TABLE "${schema}"."alembic_version" (version_num text PRIMARY KEY)`
    );
    await db.$executeRawUnsafe(`INSERT INTO "${schema}"."alembic_version" VALUES ('0002')`);
    // Stands in for ai.document_chunks: rebuildable, left out of the backup.
    await db.$executeRawUnsafe(`CREATE TABLE "${schema}"."chunks" (id int PRIMARY KEY)`);
    await db.$executeRawUnsafe(`INSERT INTO "${schema}"."chunks" VALUES (1), (2)`);
    // Rows referencing later rows: in ctid order the child comes first.
    await db.$executeRawUnsafe(
      `INSERT INTO ${child} VALUES
         (2, 1, 3, E'line\\nbreak "quoted" ünïcödé', 1234.50, '{"a":[1,null,"x"]}', '\\xdeadbeef',
          '2026-10-08T02:00:00.123456Z', '[0.5,-1,2]'),
         (3, 2, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
         (1, 7, 2, '', 0, 'null', '\\x', '1970-01-01T00:00:00Z', '[0,0,0]')`
    );
  });

  afterAll(async () => {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
  });

  it('exports every table in batches and restores the same rows', async () => {
    const before = await snapshot();
    const { body, header } = await exportSnapshot({ schemas: [schema], exclude, batchSize: 2 });

    // Foreign-key order: parent before child, whatever the names.
    expect(header.tables).toEqual([
      { name: `${schema}.parent`, rows: 7 },
      { name: `${schema}.child`, rows: 3 },
    ]);
    // Header, 4 batches for parent (2 + 2 + 2 + 1), 2 for child (2 + 1), trailer.
    expect(gunzipSync(body).toString('utf8').trim().split('\n')).toHaveLength(1 + 4 + 2 + 1);

    await db.$executeRawUnsafe(`TRUNCATE ${child}, ${parent}`);
    const { restored } = await restore(body);

    expect(restored).toEqual(header.tables);
    expect(await snapshot()).toEqual(before);
  });

  it('leaves migration history out, so it restores into a freshly migrated database', async () => {
    const { body, header } = await exportSnapshot({ schemas: [schema], exclude });
    expect(header.tables.map((table) => table.name)).toEqual([
      `${schema}.parent`,
      `${schema}.child`,
    ]);

    // The target's own migrations filled its history tables; they stay as they are.
    await db.$executeRawUnsafe(`TRUNCATE ${child}, ${parent}`);
    const { restored } = await restore(body);

    expect(restored).toEqual(header.tables);
    const [history] = await db.$queryRawUnsafe<[{ n: number }]>(
      `SELECT (SELECT count(*) FROM "${schema}"."_prisma_migrations")::int +
              (SELECT count(*) FROM "${schema}"."alembic_version")::int AS n`
    );
    expect(history.n).toBe(2);
  });

  it('pages by key: a composite primary key, and a NOT NULL unique index without one', async () => {
    const other = `${schema}_keys`;
    await db.$executeRawUnsafe(`CREATE SCHEMA "${other}"`);
    try {
      await db.$executeRawUnsafe(
        `CREATE TABLE "${other}"."pairs" (k text, n int, v text, PRIMARY KEY (k, n))`
      );
      // Inserted out of key order; keys that sort differently as text and int.
      await db.$executeRawUnsafe(
        `INSERT INTO "${other}"."pairs" VALUES ('b',10,'x'),('a',2,'y'),('b',9,'z'),('a',10,'w'),('c',1,NULL)`
      );
      // Like verification_tokens: no primary key, a unique NOT NULL column.
      await db.$executeRawUnsafe(
        `CREATE TABLE "${other}"."tokens" (identifier text, token text NOT NULL UNIQUE, at timestamptz)`
      );
      await db.$executeRawUnsafe(
        `INSERT INTO "${other}"."tokens" SELECT 'i', 't' || g, '2026-10-08T00:00:00Z'::timestamptz + g * interval '1 second'
           FROM generate_series(1, 5) g`
      );
      const { body, header } = await exportSnapshot({ schemas: [other], batchSize: 2 });
      expect(header.tables).toEqual([
        { name: `${other}.pairs`, rows: 5 },
        { name: `${other}.tokens`, rows: 5 },
      ]);
      const pairs = readBackup(body)
        .batches.filter((batch) => batch.table === `${other}.pairs`)
        .flatMap((batch) => batch.rows as { k: string; n: number }[])
        .map((row) => `${row.k}${row.n}`);
      expect(pairs).toEqual(['a2', 'a10', 'b9', 'b10', 'c1']);

      // Nothing to page by: refuse rather than guess.
      await db.$executeRawUnsafe(`CREATE TABLE "${other}"."loose" (v text)`);
      await expect(exportSnapshot({ schemas: [other] })).rejects.toThrow(
        /loose has no primary key/
      );
    } finally {
      await db.$executeRawUnsafe(`DROP SCHEMA "${other}" CASCADE`);
    }
  });

  it('refuses a truncated file and loads nothing from it', async () => {
    const { body } = await exportSnapshot({ schemas: [schema], exclude, batchSize: 2 });
    const { gzipSync } = await import('node:zlib');
    const lines = gunzipSync(body).toString('utf8').trim().split('\n');
    // Cut after the parent batches: no child rows, no trailer.
    const cut = gzipSync(lines.slice(0, 5).join('\n') + '\n');

    await db.$executeRawUnsafe(`TRUNCATE ${child}, ${parent}`);
    await expect(restore(cut)).rejects.toThrow(/truncated/);
    const [{ n }] = await db.$queryRawUnsafe<[{ n: number }]>(
      `SELECT count(*)::int AS n FROM ${parent}`
    );
    expect(n).toBe(0);
    await restore(body); // leave the rows for the next tests
  });

  it('uploads only ciphertext, and a wrong key restores nothing', async () => {
    const { body, sealed } = await exportSnapshot({ schemas: [schema], exclude });
    expect(sealed.subarray(0, 8).toString('latin1')).toBe('WOLFENC1');
    expect(sealed.includes(Buffer.from(`${schema}.parent`))).toBe(false);

    await db.$executeRawUnsafe(`TRUNCATE ${child}, ${parent}`);
    await expect(restore(body, randomBytes(32))).rejects.toThrow(/BACKUP_ENCRYPTION_KEY|damaged/);
    const [{ n }] = await db.$queryRawUnsafe<[{ n: number }]>(
      `SELECT count(*)::int AS n FROM ${parent}`
    );
    expect(n).toBe(0);
    await restore(body); // leave the rows for the next tests
  });

  it('refuses to restore into tables that hold rows', async () => {
    const { body } = await exportSnapshot({ schemas: [schema], exclude });

    await expect(restore(body)).rejects.toThrow(/not empty/);
  });

  it('refuses a target without the schema', async () => {
    const { body } = await exportSnapshot({ schemas: [schema], exclude });
    const other = `${schema}_x`;
    const renamed = Buffer.from(
      gunzipSync(body).toString('utf8').replaceAll(`${schema}.`, `${other}.`)
    );
    const { gzipSync } = await import('node:zlib');
    const header = JSON.parse(renamed.toString('utf8').split('\n')[0]!);
    header.schemas = [other];
    const lines = renamed.toString('utf8').split('\n');
    lines[0] = JSON.stringify(header);

    await expect(restore(gzipSync(lines.join('\n')))).rejects.toThrow(/missing tables/);
  });

  it('stops with BackupBudgetError when the deadline has passed', async () => {
    let t = 0;
    await expect(
      exportBuffer(db, { schemas: [schema], exclude, batchSize: 2, deadline: 3, now: () => t++ })
    ).rejects.toBeInstanceOf(BackupBudgetError);
  });

  it('db.backup stores one file for the run and prunes past the retention', async () => {
    const NOW = new Date('2026-10-08T21:00:00Z');
    const put: { key: string; body: Uint8Array; contentType: string }[] = [];
    const deleted: string[] = [];
    const files = [
      { key: 'db/2026-10-07.ndjson.gz.enc', lastModified: new Date('2026-10-07T21:00:00Z') },
      { key: 'db/2026-09-01.ndjson.gz', lastModified: new Date('2026-09-01T21:00:00Z') },
    ];
    const ctx = {
      db: withTenantGuard(db, { mode: 'throw' }),
      now: () => NOW,
      backups: {
        schemas: [schema],
        exclude,
        encryptionKey: KEY,
        keepDays: 14,
        store: {
          put: async (key: string, stream: Readable, contentType: string) => {
            const sealed = await collect(stream);
            put.push({
              key,
              body: await collect(Readable.from([sealed]).pipe(decryptBackup(KEY))),
              contentType,
            });
            files.push({ key, lastModified: NOW });
          },
          get: async () => Readable.from([]),
          list: async (prefix: string) => files.filter((file) => file.key.startsWith(prefix)),
          delete: async (key: string) => {
            deleted.push(key);
          },
        },
      },
    } as unknown as JobContext;

    await runJob(ctx, { type: 'db.backup', payload: {}, jobId: 'scheduled:backup' });

    expect(put).toHaveLength(1);
    expect(put[0]!.key).toBe('db/2026-10-08.ndjson.gz.enc');
    expect(put[0]!.contentType).toBe('application/octet-stream');
    const stored = readBackup(put[0]!.body).header;
    expect(stored.tables).toEqual([
      { name: `${schema}.parent`, rows: 7 },
      { name: `${schema}.child`, rows: 3 },
    ]);
    expect(stored.excluded).toEqual([`${schema}.chunks`]);
    expect(deleted).toEqual(['db/2026-09-01.ndjson.gz']);

    // A second delivery the same day (QStash retry, a drain run) does nothing.
    await runJob(ctx, { type: 'db.backup', payload: {}, jobId: 'scheduled:backup' });
    expect(put).toHaveLength(1);
  });

  it('db.backup fails loudly when no backup store is configured', async () => {
    const ctx = { db: withTenantGuard(db, { mode: 'throw' }), now: () => new Date() };

    await expect(
      runJob(ctx as unknown as JobContext, {
        type: 'db.backup',
        payload: {},
        jobId: 'scheduled:backup',
      })
    ).rejects.toThrow(/backup store/);
  });
});
