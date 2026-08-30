import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrisma } from '@wolff/database';
import {
  BackupBudgetError,
  backupKey,
  exportDatabase,
  pruneBackups,
  readBackup,
  restoreDatabase,
  type BackupStore,
} from './backup';

function memoryStore(files: { key: string; lastModified: Date }[]): BackupStore & {
  deleted: string[];
} {
  const deleted: string[] = [];
  return {
    deleted,
    put: async () => undefined,
    get: async () => new Uint8Array(),
    list: async (prefix) => files.filter((file) => file.key.startsWith(prefix)),
    delete: async (key) => {
      deleted.push(key);
    },
  };
}

describe('backupKey', () => {
  it('names one sortable file per run under db/', () => {
    expect(backupKey(new Date('2026-10-08T02:00:00.123Z'))).toBe(
      'db/2026-10-08T02-00-00-123Z.ndjson.gz'
    );
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

describe.skipIf(!url)('export and restore (Postgres)', () => {
  const db = createPrisma(url);
  const schema = `backup_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const parent = `"${schema}"."parent"`;
  const child = `"${schema}"."child"`;

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
    const { body, header } = await db.$transaction(
      (tx) => exportDatabase(tx, { schemas: [schema], batchSize: 2 }),
      { isolationLevel: 'RepeatableRead' }
    );

    expect(header.tables).toEqual([
      { name: `${schema}.child`, rows: 3 },
      { name: `${schema}.parent`, rows: 7 },
    ]);
    // 2 batches for child (2 + 1), 4 for parent (2 + 2 + 2 + 1).
    expect(gunzipSync(body).toString('utf8').trim().split('\n')).toHaveLength(1 + 2 + 4);

    await db.$executeRawUnsafe(`TRUNCATE ${child}, ${parent}`);
    const { restored } = await db.$transaction((tx) => restoreDatabase(tx, body));

    expect(restored).toEqual(header.tables);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses to restore into tables that hold rows', async () => {
    const { body } = await db.$transaction((tx) => exportDatabase(tx, { schemas: [schema] }), {
      isolationLevel: 'RepeatableRead',
    });

    await expect(db.$transaction((tx) => restoreDatabase(tx, body))).rejects.toThrow(/not empty/);
  });

  it('refuses a target without the schema', async () => {
    const { body } = await db.$transaction((tx) => exportDatabase(tx, { schemas: [schema] }), {
      isolationLevel: 'RepeatableRead',
    });
    const other = `${schema}_x`;
    const renamed = Buffer.from(
      gunzipSync(body).toString('utf8').replaceAll(`${schema}.`, `${other}.`)
    );
    const { gzipSync } = await import('node:zlib');
    const header = JSON.parse(renamed.toString('utf8').split('\n')[0]!);
    header.schemas = [other];
    const lines = renamed.toString('utf8').split('\n');
    lines[0] = JSON.stringify(header);

    await expect(restoreDatabase(db, gzipSync(lines.join('\n')))).rejects.toThrow(/missing tables/);
  });

  it('stops with BackupBudgetError when the deadline has passed', async () => {
    let t = 0;
    await expect(
      exportDatabase(db, { schemas: [schema], batchSize: 2, deadline: 3, now: () => t++ })
    ).rejects.toBeInstanceOf(BackupBudgetError);
  });
});
