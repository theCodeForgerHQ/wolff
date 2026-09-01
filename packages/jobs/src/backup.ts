import { gunzipSync, gzipSync } from 'node:zlib';

/**
 * Logical database backup for the free demo (Phase 6).
 *
 * `pg_dump` cannot run where the scheduled jobs run: a Vercel function has no
 * Postgres client binaries, and there is no other always-on host. So the
 * backup is a data-only export through the app's own connection: every table
 * of the listed schemas, read in bounded batches inside one REPEATABLE READ
 * snapshot, written as gzipped NDJSON. The schema itself is not in the file;
 * it comes from the migrations (Prisma for `public`, Alembic for `ai`), and
 * the restore loads the rows into a database that already has it (a Neon
 * schema-only branch, or a freshly migrated one).
 */

/** The part of a Prisma client (or transaction) the backup needs. */
export interface SqlRunner {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export const BACKUP_FORMAT = 'wolff-logical-backup';
export const BACKUP_VERSION = 1;

export interface BackupHeader {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  createdAt: string;
  schemas: string[];
  /** Row count per table, as read in the snapshot. */
  tables: { name: string; rows: number }[];
}

interface BatchLine {
  table: string;
  rows: unknown[];
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

export interface ExportOptions {
  schemas: string[];
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
 * Reads every table of `schemas` through `sql`, which must be a transaction
 * at REPEATABLE READ so all batches see one snapshot. Each batch starts after
 * the last key of the one before (keyset paging), so a batch costs an index
 * range scan however deep into the table it is; LIMIT/OFFSET re-read every
 * earlier row.
 */
export async function exportDatabase(
  sql: SqlRunner,
  options: ExportOptions
): Promise<{ body: Uint8Array; header: BackupHeader }> {
  const batchSize = options.batchSize ?? 500;
  const now = options.now ?? Date.now;
  const tables = await listTables(sql, options.schemas);
  const lines: string[] = [];
  const counts: BackupHeader['tables'] = [];

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
        lines.push(JSON.stringify({ table, rows: parsed } satisfies BatchLine));
        rows += parsed.length;
        const tail = parsed[parsed.length - 1]!;
        last = key.map((column) => cursorText(tail[column.name]));
      }
      if (parsed.length < batchSize) break;
    }
    counts.push({ name: table, rows });
  }

  const header: BackupHeader = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date(now()).toISOString(),
    schemas: options.schemas,
    tables: counts,
  };
  const text = [JSON.stringify(header), ...lines].join('\n') + '\n';
  return { body: gzipSync(Buffer.from(text, 'utf8')), header };
}

export function readBackup(body: Uint8Array): { header: BackupHeader; batches: BatchLine[] } {
  const lines = gunzipSync(body).toString('utf8').split('\n').filter(Boolean);
  const header = JSON.parse(lines[0] ?? 'null') as BackupHeader | null;
  if (header?.format !== BACKUP_FORMAT || header.version !== BACKUP_VERSION) {
    throw new Error('Not a wolff logical backup (format or version mismatch)');
  }
  return { header, batches: lines.slice(1).map((line) => JSON.parse(line) as BatchLine) };
}

/**
 * Tables in an order where every foreign key points at a table loaded
 * earlier. A table referencing itself is fine: its rows go in one statement,
 * and Postgres checks a non-deferred foreign key at the end of the statement.
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
 * Loads a backup into a database that has the schema and no rows. Runs in
 * whatever `sql` is; pass a transaction so a failed restore leaves nothing.
 * Returns the row count of every table after loading, read back from the
 * database, for comparison with the header.
 */
export async function restoreDatabase(
  sql: SqlRunner,
  body: Uint8Array
): Promise<{ header: BackupHeader; restored: BackupHeader['tables'] }> {
  const { header, batches } = readBackup(body);
  const tables = header.tables.map((table) => table.name);
  const existing = new Set(await listTables(sql, header.schemas));
  const missing = tables.filter((table) => !existing.has(table));
  if (missing.length > 0) {
    throw new Error(`Target is missing tables ${missing.join(', ')}; migrate it first`);
  }
  for (const table of tables) {
    const [{ n }] = await sql.$queryRawUnsafe<[{ n: number }]>(
      `SELECT count(*)::int AS n FROM ${qualified(table)}`
    );
    if (n > 0) throw new Error(`Target table ${table} is not empty; restore needs empty tables`);
  }

  const rowsByTable = new Map<string, unknown[]>();
  for (const { table, rows } of batches) {
    rowsByTable.set(table, [...(rowsByTable.get(table) ?? []), ...rows]);
  }
  for (const table of await loadOrder(sql, tables)) {
    const rows = rowsByTable.get(table);
    if (!rows || rows.length === 0) continue;
    // json_populate_recordset casts each value with the column's input
    // function, so timestamps, numerics, bytea (\x hex) and pgvector types
    // come back as they were exported by row_to_json.
    await sql.$queryRawUnsafe(
      `INSERT INTO ${qualified(table)}
       SELECT * FROM json_populate_recordset(NULL::${qualified(table)}, $1::json)`,
      JSON.stringify(rows)
    );
  }

  const restored: BackupHeader['tables'] = [];
  for (const table of tables) {
    const [{ n }] = await sql.$queryRawUnsafe<[{ n: number }]>(
      `SELECT count(*)::int AS n FROM ${qualified(table)}`
    );
    restored.push({ name: table, rows: n });
  }
  return { header, restored };
}

/** Storage for backup files: put, list by prefix, delete, get. */
export interface BackupStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  list(prefix: string): Promise<{ key: string; lastModified: Date }[]>;
  delete(key: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
}

export const BACKUP_PREFIX = 'db/';

/**
 * `db/2026-08-30.ndjson.gz`: one file per UTC day, so a retried or repeated
 * run on the same day finds its file and does nothing.
 */
export function backupKey(at: Date): string {
  return `${BACKUP_PREFIX}${at.toISOString().slice(0, 10)}.ndjson.gz`;
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
