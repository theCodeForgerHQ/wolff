# ADR 0008: Nightly logical backups, encrypted, through the app's own connection

- Status: accepted (Phase 6)
- Phase docs: [phase-6](../phase-6.md), [runbook §4](../runbook.md)

## Context

The spec asked for a nightly `pg_dump`. A Vercel function has no Postgres
client binaries, there is no always-on host, and there is no repository for
a GitHub Actions step. Neon's free point-in-time window is 6 hours.

## Decision

`db.backup` (a QStash schedule, 02:30 IST) exports every table of `public`
and `ai` in one REPEATABLE READ transaction, in foreign-key order, in
500-row batches paged by primary key. It streams NDJSON through gzip and
AES-256-GCM (`BACKUP_ENCRYPTION_KEY`) into a multipart upload to a private
Supabase bucket, with a header listing the tables and a trailer with row
counts; a file without the trailer is refused. Migration history and the
rebuildable RAG index are left out. Restore streams the file into an empty,
migrated database in one transaction and compares row counts per table.
Retention keeps 14 days.

## Consequences

- Restore drill on the live demo: 61 tables, 1,376 rows, 0 mismatches, 80.8 s
  into a scratch Neon branch. The file is 150,077 bytes.
- The schema comes from the migrations, not the file; sequences, roles and
  grants are not in it (the schema has no sequences today).
- The export must finish within a 200 s budget, or no file is stored. That
  bounds the database size this works for.
- Losing `BACKUP_ENCRYPTION_KEY` makes every backup unreadable; the runbook
  says to keep a second copy.
