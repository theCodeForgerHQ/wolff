import { createInterface } from 'node:readline';
import { PassThrough, Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pipeline as pipe } from 'node:stream';
import { createGunzip, createGzip, gunzipSync } from 'node:zlib';
import { decryptBackup, encryptBackup } from './backup-cipher';

/**
 * Logical database backup for the free demo (Phase 6).
 *
 * `pg_dump` cannot run where the scheduled jobs run: a Vercel function has no
 * Postgres client binaries, and there is no other always-on host. So the
 * backup is a data-only export through the app's own connection: every table
 * of the listed schemas, read in bounded batches inside one REPEATABLE READ
 * snapshot, streamed as gzipped NDJSON straight into the upload, so memory
 * holds one batch and one upload part, not the file. The schema itself is not in the file;
 * it comes from the migrations (Prisma for `public`, Alembic for `ai`), and
 * the restore loads the rows into a database that already has it (a Neon
 * schema-only branch, or a freshly migrated one).
 */

/** The part of a Prisma client (or transaction) the backup needs. */
export interface SqlRunner {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export const BACKUP_FORMAT = 'wolff-logical-backup';
/** 2: header, batches in foreign-key order, trailer with the row counts. */
export const BACKUP_VERSION = 2;

export interface BackupHeader {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  createdAt: string;
  schemas: string[];
  /** Tables left out on purpose (rebuildable data); empty after a restore. */
  excluded: string[];
  /** Row count per table, as read in the snapshot. */
  tables: { name: string; rows: number }[];
}

interface BatchLine {
  table: string;
  rows: unknown[];
}

/** First line of the file: what follows, in load order. Counts come last. */
interface FileHeader {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  createdAt: string;
  schemas: string[];
  excluded: string[];
  tables: string[];
}

/** Last line. Its absence means the file was cut short. */
interface FileTrailer {
  end: true;
  tables: BackupHeader['tables'];
}

export class BackupBudgetError extends Error {
  constructor(table: string) {
    super(
      `Backup ran out of time while reading ${table}; the database has outgrown the in-function export`
    );
    this.name = 'BackupBudgetError';
  }
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

/** Quotes a schema-qualified name; refuses anything that is not a plain identifier. */
function qualified(name: string): string {
  const parts = name.split('.');
  if (parts.length !== 2 || !parts.every((part) => IDENT.test(part))) {
    throw new Error(`Refusing unexpected table name ${JSON.stringify(name)}`);
  }
  return parts.map((part) => `"${part}"`).join('.');
}

/**
 * Migration history (Prisma's and Alembic's), in any schema. It describes the
 * schema, not the data: the restore target was migrated and has its own
 * history rows, so these tables are neither exported nor loaded.
 */
export const MIGRATION_HISTORY_TABLES = ['_prisma_migrations', 'alembic_version'];

async function listTables(sql: SqlRunner, schemas: string[]): Promise<string[]> {
  const rows = await sql.$queryRawUnsafe<{ name: string }[]>(
    `SELECT n.nspname || '.' || c.relname AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname = ANY($1::text[])
        AND c.relname <> ALL($2::text[])
      ORDER BY 1`,
    schemas,
    MIGRATION_HISTORY_TABLES
  );
  return rows.map((row) => row.name);
}

/** A key value from row_to_json, as text its column type's input accepts. */
function cursorText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Data the backup leaves out because it can be rebuilt from the rest: the
 * RAG index (2048-dimension embeddings, most of the bytes) and its
 * bookkeeping. With ai.ingest_state empty, the ai.sweep job finds every
 * source unindexed and embeds it again (docs/runbook.md, Restore).
 */
export const REBUILDABLE_TABLES = ['ai.document_chunks', 'ai.ingest_state'];

export interface ExportOptions {
  schemas: string[];
  /** Schema-qualified tables to leave out, such as REBUILDABLE_TABLES. */
  exclude?: string[];
  /** Rows per query. */
  batchSize?: number;
  /** Stop with BackupBudgetError when a batch would start after this time (ms epoch). */
  deadline?: number;
  now?: () => number;
}

interface KeyColumn {
  name: string;
  /** format_type(): the type to cast the cursor value back to. */
  type: string;
}

/**
 * The columns to page a table by: its primary key, or else a unique index
 * whose columns are all NOT NULL (no expressions, no predicate). A table with
 * neither cannot be paged reliably, so the backup refuses it.
 */
async function pageKey(sql: SqlRunner, table: string): Promise<KeyColumn[]> {
  const indexes = await sql.$queryRawUnsafe<{ columns: KeyColumn[] }[]>(
    `SELECT json_agg(json_build_object('name', a.attname,
                                       'type', format_type(a.atttypid, a.atttypmod))
                     ORDER BY k.ord) AS columns
       FROM pg_index i
       CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
      WHERE i.indrelid = $1::regclass AND i.indisunique AND i.indpred IS NULL
        AND i.indexprs IS NULL
      GROUP BY i.indexrelid, i.indisprimary
     HAVING bool_and(a.attnotnull)
      ORDER BY i.indisprimary DESC, count(*), i.indexrelid
      LIMIT 1`,
    qualified(table)
  );
  const columns = indexes[0]?.columns;
  if (!columns || columns.length === 0) {
    throw new Error(
      `${table} has no primary key or NOT NULL unique index; the backup cannot page it`
    );
  }
  for (const column of columns) {
    if (!IDENT.test(column.name)) {
      throw new Error(`Refusing unexpected column name ${JSON.stringify(column.name)}`);
    }
  }
  return columns;
}

/**
 * Tables in an order where every foreign key points at a table loaded
 * earlier. A table referencing itself is fine: the restore stages its rows
 * and inserts them in one statement, and Postgres checks a non-deferred
 * foreign key at the end of the statement.
 */
async function loadOrder(sql: SqlRunner, tables: string[]): Promise<string[]> {
  const edges = await sql.$queryRawUnsafe<{ child: string; parent: string }[]>(
    `SELECT cn.nspname || '.' || c.relname AS child, pn.nspname || '.' || p.relname AS parent
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace cn ON cn.oid = c.relnamespace
       JOIN pg_class p ON p.oid = k.confrelid JOIN pg_namespace pn ON pn.oid = p.relnamespace
      WHERE k.contype = 'f'`
  );
  const wanted = new Set(tables);
  const parents = new Map(tables.map((table) => [table, new Set<string>()]));
  for (const { child, parent } of edges) {
    if (child !== parent && wanted.has(child) && wanted.has(parent)) {
      parents.get(child)!.add(parent);
    }
  }
  const order: string[] = [];
  const done = new Set<string>();
  while (order.length < tables.length) {
    const ready = tables.filter(
      (table) => !done.has(table) && [...parents.get(table)!].every((p) => done.has(p))
    );
    if (ready.length === 0) {
      const left = tables.filter((table) => !done.has(table));
      throw new Error(`Foreign key cycle between ${left.join(', ')}; cannot order the restore`);
    }
    for (const table of ready) {
      order.push(table);
      done.add(table);
    }
  }
  return order;
}

/**
 * Yields the backup as NDJSON lines, reading every table of `schemas` through
 * `sql`, which must be a transaction at REPEATABLE READ so all batches see one
 * snapshot. Each batch starts after the last key of the one before (keyset
 * paging), so a batch costs an index range scan however deep into the table
 * it is; LIMIT/OFFSET re-read every earlier row. Tables come in foreign-key
 * order, so the restore can load them as they arrive. Returns the header
 * with the row counts.
 */
async function* exportLines(
  sql: SqlRunner,
  options: ExportOptions
): AsyncGenerator<string, BackupHeader> {
  const batchSize = options.batchSize ?? 500;
  const now = options.now ?? Date.now;
  const excluded = options.exclude ?? [];
  const listed = (await listTables(sql, options.schemas)).filter((t) => !excluded.includes(t));
  const tables = await loadOrder(sql, listed);
  const createdAt = new Date(now()).toISOString();
  const counts: BackupHeader['tables'] = [];
  yield line({
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt,
    schemas: options.schemas,
    excluded,
    tables,
  } satisfies FileHeader);

  for (const table of tables) {
    const key = await pageKey(sql, table);
    const keyList = key.map((column) => `"${column.name}"`).join(', ');
    // ($2::text::type, ...): the cursor travels as text and is cast back to
    // the column type, so the comparison uses the column's own ordering.
    const cursor = key.map((column, i) => `$${i + 2}::text::${column.type}`).join(', ');
    let last: unknown[] | undefined;
    let rows = 0;
    for (;;) {
      if (options.deadline !== undefined && now() >= options.deadline) {
        throw new BackupBudgetError(table);
      }
      const where = last ? `WHERE (${keyList}) > (${cursor})` : '';
      const [{ batch }] = await sql.$queryRawUnsafe<[{ batch: string }]>(
        `SELECT coalesce(json_agg(row_to_json(t)), '[]')::text AS batch
           FROM (SELECT * FROM ${qualified(table)} ${where} ORDER BY ${keyList} LIMIT $1) t`,
        batchSize,
        ...(last ?? [])
      );
      const parsed = JSON.parse(batch) as Record<string, unknown>[];
      if (parsed.length > 0) {
        yield line({ table, rows: parsed } satisfies BatchLine);
        rows += parsed.length;
        const tail = parsed[parsed.length - 1]!;
        last = key.map((column) => cursorText(tail[column.name]));
      }
      if (parsed.length < batchSize) break;
    }
    counts.push({ name: table, rows });
  }

  yield line({ end: true, tables: counts } satisfies FileTrailer);
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt,
    schemas: options.schemas,
    excluded,
    tables: counts,
  };
}

const line = (value: unknown) => JSON.stringify(value) + '\n';

/** Counts the bytes passing through, for the job's log line. */
function byteCounter(): Transform & { bytes: number } {
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      counter.bytes += chunk.length;
      done(null, chunk);
    },
  }) as Transform & { bytes: number };
  counter.bytes = 0;
  return counter;
}

/**
 * Streams the export through gzip and AES-256-GCM (backup-cipher.ts) into
 * `upload`, which must consume the stream to its end. An upload that fails
 * stops the export; an export that fails errors the stream, so the upload
 * must not store what it got (the S3 store aborts the multipart upload).
 */
export async function writeBackup(
  sql: SqlRunner,
  options: ExportOptions,
  upload: (body: Readable) => Promise<void>,
  key: Buffer
): Promise<{ header: BackupHeader; bytes: number }> {
  let header: BackupHeader | undefined;
  async function* source() {
    header = yield* exportLines(sql, options);
  }
  const counter = byteCounter();
  const body = new PassThrough();
  const sent = upload(body).catch((error: unknown) => {
    body.destroy(error instanceof Error ? error : new Error(String(error)));
    throw error;
  });
  await Promise.all([
    pipeline(Readable.from(source()), createGzip(), encryptBackup(key), counter, body),
    sent,
  ]);
  return { header: header!, bytes: counter.bytes };
}

function checkHeader(value: unknown): FileHeader {
  const header = value as Partial<FileHeader> | null;
  if (header?.format !== BACKUP_FORMAT || header.version !== BACKUP_VERSION) {
    throw new Error(
      `Not a wolff logical backup version ${BACKUP_VERSION} (format or version mismatch)`
    );
  }
  return header as FileHeader;
}

const TRUNCATED = 'Backup file is truncated (no trailer)';

/** Parses a whole decompressed backup in memory; for inspection and tests. */
export function readBackup(body: Uint8Array): { header: BackupHeader; batches: BatchLine[] } {
  const lines = gunzipSync(body).toString('utf8').split('\n').filter(Boolean);
  const file = checkHeader(JSON.parse(lines[0] ?? 'null'));
  const trailer = JSON.parse(lines[lines.length - 1] ?? 'null') as Partial<FileTrailer> | null;
  if (lines.length < 2 || trailer?.end !== true) throw new Error(TRUNCATED);
  return {
    header: { ...file, tables: trailer.tables! },
    batches: lines.slice(1, -1).map((text) => JSON.parse(text) as BatchLine),
  };
}

/**
 * Loads a backup stream (as stored: encrypted, gzipped) into a database that has
 * the schema and no rows, table by table as the lines arrive. Each table's
 * batches go into a temporary staging table first and then into the real one
 * in a single INSERT, because Postgres checks a non-deferred foreign key at
 * the end of the statement: a row may reference a row of its own table in a
 * later batch. Run it in a transaction: a file without its trailer (cut
 * short) throws at the end, after rows were loaded. Returns the header with
 * the counts from the trailer, and every table's count read back from the
 * database.
 */
export async function restoreDatabase(
  sql: SqlRunner,
  body: Readable,
  key: Buffer
): Promise<{ header: BackupHeader; restored: BackupHeader['tables'] }> {
  // A failure anywhere (download, authentication, gzip) destroys the last
  // stream with that error, and the line reader below throws it.
  const input = pipe(body, decryptBackup(key), createGunzip(), () => undefined);
  const lines = createInterface({ input, crlfDelay: Infinity })[Symbol.asyncIterator]();

  const first = await lines.next();
  const file = checkHeader(first.done ? null : JSON.parse(first.value));
  const existing = new Set(await listTables(sql, file.schemas));
  const missing = file.tables.filter((table) => !existing.has(table));
  if (missing.length > 0) {
    throw new Error(`Target is missing tables ${missing.join(', ')}; migrate it first`);
  }
  for (const table of file.tables) {
    if ((await countRows(sql, table)) > 0) {
      throw new Error(`Target table ${table} is not empty; restore needs empty tables`);
    }
  }

  let staging: string | undefined;
  const flush = async () => {
    if (!staging) return;
    await sql.$queryRawUnsafe(
      `INSERT INTO ${qualified(staging)} SELECT * FROM pg_temp.wolff_restore_stage`
    );
    await sql.$queryRawUnsafe(`DROP TABLE pg_temp.wolff_restore_stage`);
    staging = undefined;
  };
  let trailer: FileTrailer | undefined;
  for (let next = await lines.next(); !next.done; next = await lines.next()) {
    if (!next.value) continue;
    const parsed = JSON.parse(next.value) as BatchLine | FileTrailer;
    if ('end' in parsed) {
      trailer = parsed;
      continue;
    }
    if (trailer) throw new Error('Backup file has data after its trailer');
    const { table, rows } = parsed;
    if (!file.tables.includes(table)) throw new Error(`Backup batch for unlisted table ${table}`);
    if (staging !== table) {
      await flush();
      // LIKE copies the columns and their types, no constraints.
      await sql.$queryRawUnsafe(
        `CREATE TEMP TABLE wolff_restore_stage (LIKE ${qualified(table)}) ON COMMIT DROP`
      );
      staging = table;
    }
    // json_populate_recordset casts each value with the column's input
    // function, so timestamps, numerics, bytea (\x hex) and pgvector types
    // come back as they were exported by row_to_json.
    await sql.$queryRawUnsafe(
      `INSERT INTO pg_temp.wolff_restore_stage
       SELECT * FROM json_populate_recordset(NULL::${qualified(table)}, $1::json)`,
      JSON.stringify(rows)
    );
  }
  if (!trailer) throw new Error(TRUNCATED);
  await flush();

  const restored: BackupHeader['tables'] = [];
  for (const table of file.tables) {
    restored.push({ name: table, rows: await countRows(sql, table) });
  }
  return { header: { ...file, tables: trailer.tables }, restored };
}

async function countRows(sql: SqlRunner, table: string): Promise<number> {
  const [{ n }] = await sql.$queryRawUnsafe<[{ n: number }]>(
    `SELECT count(*)::int AS n FROM ${qualified(table)}`
  );
  return n;
}

/** Storage for backup files: put, list by prefix, delete, get. */
export interface BackupStore {
  /** Stores the stream once it ends; stores nothing if it errors. */
  put(key: string, body: Readable, contentType: string): Promise<void>;
  list(prefix: string): Promise<{ key: string; lastModified: Date }[]>;
  delete(key: string): Promise<void>;
  get(key: string): Promise<Readable>;
}

export const BACKUP_PREFIX = 'db/';

/**
 * `db/2026-08-30.ndjson.gz.enc`: one file per UTC day, so a retried or repeated
 * run on the same day finds its file and does nothing.
 */
export function backupKey(at: Date): string {
  return `${BACKUP_PREFIX}${at.toISOString().slice(0, 10)}.ndjson.gz.enc`;
}

/**
 * Deletes backups older than `keepDays`, never the newest one, so a run of
 * failed backups cannot prune the last good file away.
 */
export async function pruneBackups(
  store: BackupStore,
  now: Date,
  keepDays: number
): Promise<string[]> {
  if (!Number.isInteger(keepDays) || keepDays < 1) {
    throw new Error(`keepDays must be a whole number of days >= 1, got ${keepDays}`);
  }
  const files = (await store.list(BACKUP_PREFIX)).sort(
    (a, b) => b.lastModified.getTime() - a.lastModified.getTime()
  );
  const cutoff = now.getTime() - keepDays * 24 * 60 * 60 * 1000;
  const old = files.slice(1).filter((file) => file.lastModified.getTime() < cutoff);
  for (const file of old) await store.delete(file.key);
  return old.map((file) => file.key);
}
