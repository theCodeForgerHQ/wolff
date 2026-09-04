# Phase 6: Operations (backups, rollback, alerts, runbook)

Branch `phase6-operations` from tag `phase6b-closed` (`1c548af`). Nothing pushed.
Reviewed; the findings and their fixes are in "Review findings
and fixes" at the end. Pre-fix tag `phase6-pre-review-fixes` (`6ca9d7a`).

## Commits

| Commit               | What                                                                          |
| -------------------- | ----------------------------------------------------------------------------- |
| `7646fcc`            | fix(ai): answer HEAD on /healthz (the "wolff-ai down" false alarm)            |
| `8ea32b6`            | feat(jobs): logical database export, restore and backup pruning               |
| `8c3f942`            | feat(jobs): S3 backup store with list, get and delete                         |
| `db718fc`            | feat(jobs): nightly db.backup job on a QStash schedule                        |
| `598bd9f`            | feat(api): backup:restore script with per-table count comparison              |
| `0777f05`            | feat(ops): one-command deploy with smoke tests and automatic rollback         |
| `8ed37ec`            | feat(ops): Sentry alert workflows for new, regressed and spiking issues       |
| `d4e5b98`            | fix(ops): promote the new deployment when Vercel did not (found in the drill) |
| `083900b`, `3a84b25` | docs(ops): runbook, then the other developer's gaps                               |

## Backup design (deviation from "pg_dump")

The design asks for a nightly `pg_dump`. A Vercel function has no Postgres client
binaries, there is no always-on host, and there is no pushed repo for a
GitHub Actions step. So `db.backup` is a **data-only logical export through
the app's own connection**: every table of `public` and `ai` inside one
REPEATABLE READ transaction, except the migration history
(`_prisma_migrations`, `alembic_version`: the target's own migrations write
them) and the rebuildable RAG index (`ai.document_chunks`,
`ai.ingest_state`; the hourly `ai.sweep` re-embeds after a restore). Tables
are read in 500-row batches paged by primary key (or a NOT NULL unique index),
in foreign-key order, and streamed as NDJSON through gzip and AES-256-GCM
(`BACKUP_ENCRYPTION_KEY`) into a multipart upload: memory holds one batch and
one 5 MiB part. Format version 2: a header listing the tables, the batches,
and a trailer with the row counts; a file without the trailer is refused.
Schema comes from the migrations. The restore streams the file into an empty,
migrated database in one transaction, staging each table so a row may
reference a later batch of its own table. Rejected: a static `pg_dump` in the
bundle (unpinned binary, server-version match), Actions (no repo). Limits: the
export has a 200 s budget and fails (no file is stored) beyond it; sequences,
roles and grants are not in the file (the schema has no sequences today).

The design's earlier "restore into a local container" is superseded by the
the plan's text "a scratch Neon branch", which is what was done.

## Completion criteria

### A restore from the latest backup, performed and timed — met

- Backup: QStash publish 01:03:50Z, `msg_26hZCxZC...` DELIVERED 200;
  object `backups/db/2026-08-30.ndjson.gz`, 1,195,935 bytes, created 01:03:52.954Z.
- Neon schema-only branches are refused ("project with a legacy web access
  role do not support schema-only branches; role: ai_reader"), so the target
  was a copy of `main` emptied (public TRUNCATE; ai DELETE, because
  `neondb_owner` cannot SET ROLE ai_owner).
- Timings: branch create 4.3 s; emptying 3.1 s + 2.9 s; restore script 62.1 s
  (download 2.0 s, load 58.2 s); branch delete 4.0 s.
- Output: `tables 65, rows 1632, mismatches 0`. Spot check source vs restored:
  invoices 67/67, clients 23/23, ai.document_chunks 116/116, md5 of invoice
  ids+totals equal (`c16524ac...` both).
- Second-operator repeat: 65 tables, 1,632 rows, 0 mismatches, restore 58 s.
- Repeat after the review fixes (2026-08-30 02:04-02:08 UTC, api `e91463b`):
  QStash publish 02:04:50Z, DELIVERED 200 2.1 s after creation; object
  `backups/db/2026-08-30.ndjson.gz.enc`, **150,077 bytes** (was 1,195,935: the
  embeddings are no longer in it), `application/octet-stream`, starts with the
  `WOLFENC1` header. Restored with `BACKUP_ENCRYPTION_KEY` into a copy of
  `main` emptied **except its migration history** (23 Prisma + 1 Alembic rows,
  still 23 + 1 afterwards): `tables 61, rows 1376, mismatches 0` (65 tables
  minus the 2 history and 2 RAG tables; 1,632 rows minus 23 + 1 history rows and
  116 + 116 RAG rows). Timings: branch 5.9 s, emptying 12.8 s, restore script
  80.8 s (download and load are one stream now), delete 3.6 s. invoices 67/67,
  clients 23/23, md5 of invoice ids+totals equal on branch and main
  (`694d7018...`). The load is slower than the 58 s before; the likely cause
  (inferred, not measured) is the extra round trips to us-east-1 per table for
  the staging table's create, insert and drop. `ai.document_chunks` is 0 on the branch until
  `ai.sweep` runs; the sweep was not run on the scratch branch.

### A point-in-time restore, performed and timed — met

Branch from `main` at 2026-08-30T00:20:00Z: create 3.9 s, first query 2.9 s,
delete 3.5 s. INV-KS-032 `sent_at` on the branch 2026-08-23 17:20:43; on main
2026-08-30 00:26:32 (sent at 00:26 in Phase 6b), so the branch shows the past.
Neon free history window: `history_retention_seconds` 21600 (6 h).

### A broken deploy caught and rolled back automatically (observed) — met

Throwaway commit (worktree, never merged, branch deleted) made `/readyz` answer 500. `scripts/deploy.sh drill-broken-readyz api`:

```
01:09:18.402Z api: deployed https://wolff-5u34aesvk-...vercel.app
01:09:36.904Z api: GET /readyz answered 500, expected 200; rolling back
01:09:42.714Z api: rolled back to https://wolff-31zo8e5k3-...vercel.app
"api.deploy": 99148, "api.smoke": 18501, "api.rollback": 5808, "recovered": true
```

Exit 1; `/readyz` 200 afterwards. Broken production for 24 s.

Finding: after the rollback the project had `autoAssignCustomDomains=false`, so
the next `--prod` deploy would not take the domain and the smoke test would
have tested the old deployment. Fixed in `d4e5b98` (test first: red, then
green); the restoring deploy of the tip then ran `api.promote` 5.2 s, smoke
1.8 s, and the flag is true again. Full three-project deploy of `0777f05`:
3 m 32 s, all smoke tests passed.

### An alert fires and reaches the owner's email — met

- **UptimeRobot → the owner's Gmail: met.** himalaya: 6984 "Monitor is
  DOWN: wolff-ai.vercel.app/healthz" (2026-08-23 16:33Z, root cause "HTTP 405 -
  Method Not Allowed") and 7009 "Monitor is UP: wolff-ai.vercel.app/healthz"
  (2026-08-30 01:03Z, one minute after the fixed ai went live). No deliberate
  break was made: the Chrome on 127.0.0.1:9333 was not running, so there was no
  dashboard access and no UptimeRobot API key was created.
- **Sentry → the owner's Gmail: met (2026-08-30).** Workflow `wolff: new or
regressed issue` (1346056) `lastTriggered` 01:02:22Z after a
  `sentry-cli send-event` at 01:02:09Z, but at first the only Sentry member
  address was the owner's Proton address and Gmail had no mail from Sentry.
  The owner then added and verified the Gmail address in Sentry; a test event
  to wolff-api at 01:30 UTC produced issue WOLFF-API-7, and its alert email
  arrived in Gmail at 01:30 UTC (two copies).
- False alarm fix: the cause was not a cold start. UptimeRobot checks with HEAD,
  and FastAPI's GET route answered 405 (`curl -I`: ai 405, api 200). Fixed in
  `7646fcc`; monitor timeout unchanged; warm `/healthz` 0.7-1.0 s.

### The runbook followed end to end by the other developer — met for operations, not for setup from zero

The developer who had not written the runbook ran deploy (106 s, exit 0), backup,
restore (0 mismatches), PITR, the Sentry test, the alert script (updated, no
duplicates) and on-call checks: all passed. It reported 14 text gaps, fixed in
`3a84b25`. Setup from zero and secret rotation were reviewed against the live
projects but not executed (would need new accounts / would rotate live secrets).

## Checks (Node 24.21.0, at `d4e5b98`; later commits are docs only)

- type-check: 14/14 tasks; lint: 0 errors (56 warnings, web, pre-existing); build 4/4.
- jobs with Postgres + Redis + S3Mock: 94 tests, 93 passed + 1 skipped after the
  scheduler-list update; api: 437 tests (this line said 430 before the review;
  437 is the count at `6ca9d7a`). The api failures seen in the full run came from
  the packages sharing one test database; fixed in `bb8fb59` (see the review
  section). The local DB had to be migrated first (Docker was reset on 2026-08-30).
- deploy tests 15/15 (`src/deploy`); ai pytest 143 passed, 92 skipped (DB tests
  skipped: no AI test DB env); ruff, format, mypy clean.
- Tests bite: removing FK ordering or the keep-newest rule turns 4 backup tests
  red; removing the promote step turns its test red.

## Live changes

- Supabase private bucket `backups`; wolff-api env `BACKUP_BUCKET=backups`, and
  `BACKUP_ENCRYPTION_KEY` (added in the review fixes; value in the owner's
  `secrets.env`).
- QStash: 8 schedules (new `wolff-backup`, `0 21 * * *`).
- Sentry workflows 1346056, 1346057 (email to the org owner).
- Deployed: api, ai, web from `0777f05`; api again from `d4e5b98`; api again
  from `e91463b` with the fixed deploy script (review fixes; current).
- Neon: 3 drill branches + 2 by the second operator created and deleted; only `main`.

## Owner items

1. Done 2026-08-30: Sentry alert email reaches Gmail (WOLFF-API-7).
2. Optional: a deliberate UptimeRobot down/up test (pause is silent; edit a
   monitor URL to a 404 path for 10 minutes), which needs dashboard access.
3. Neon schema-only branches are blocked by the legacy web access role
   `ai_reader`; the runbook works around it.
4. Done in the review fixes: backups are encrypted before upload. Keep a second
   copy of `BACKUP_ENCRYPTION_KEY` (password manager): without it every backup
   is unrecoverable.
5. `backups/db/2026-08-30.ndjson.gz` is the last plaintext (version 1) file,
   with the embeddings. The new code cannot read it; retention deletes it from
   2026-09-03, or delete it now.
6. When a GitHub repo exists: repository secrets `BACKUP_BUCKET` and
   `BACKUP_ENCRYPTION_KEY` for `jobs-drain.yml`.

## Review findings and fixes

All findings were checked against the code first; all nine held. Fixes are
test-first; each fix's test was seen red before the fix, and the backup fixes
were reverted one at a time in a `/tmp` worktree to confirm their tests go red
(history exclusion, staging, trailer check, table exclusion, GCM tag check).

| #   | Finding                                                                                     | Fix                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | HIGH: only `deploy()` errors were caught; promote/alias/rollback errors escaped mid-release | `6ea403b` every step's error fails the release, each rollback in its own try/catch (`rollbackFailed`); `9b586a6` no parsed deployment URL fails the deploy                                                         |
| 2   | HIGH: restore into a migrated DB failed on `_prisma_migrations` / `ai.alembic_version`      | `6e1c5c6` both are left out of export and restore; runbook no longer empties them. The claim in `8ea32b6` ("or a freshly migrated database") was false until this fix                                              |
| 3   | MEDIUM: packages ran in parallel against one test DB                                        | `bb8fb59` per-package copy `<base>_t_<pkg>` via a vitest globalSetup. The 3 green runs also needed `e91463b` (new multipart tests' timeout) and `e54cd5c` (Redis-loss test waits independent of the relay backoff) |
| 4   | MEDIUM: LIMIT/OFFSET, three in-memory copies, embeddings in the file                        | `ced3fb2` keyset paging; `910ceec` streamed gzip into a multipart upload, streamed restore (format 2); `5411f86` RAG tables excluded, rebuilt by `ai.sweep` (runbook 4.2)                                          |
| 5   | MEDIUM: no check that promote moved the alias                                               | `023f64d` alias re-read after promote; mismatch fails and rolls back                                                                                                                                               |
| 6   | MEDIUM: backups unencrypted                                                                 | `fc1ee55` AES-256-GCM with `BACKUP_ENCRYPTION_KEY` (set on wolff-api; in the owner's `secrets.env`); no separate storage key (Supabase S3 keys are project-wide, so it would not narrow access)                    |
| 7   | LOW: jobs-drain lacked the backup env                                                       | `f855911`                                                                                                                                                                                                          |
| 8   | LOW: unknown project name deployed nothing and exited 0                                     | `f476893` exits 2 with the valid names                                                                                                                                                                             |
| 9   | LOW: wrong test counts, personal addresses in docs                                          | this doc: api 437 at `6ca9d7a`, ai 234 passed + 1 skipped with the AI test DB (143 + 92 skipped without it); addresses replaced in phase-5 and phase-6 docs                                                        |

Measured on the live demo: backup 1,195,935 → 150,077 bytes; QStash had
the job's 200 2.1 s after the message was created; restore of the encrypted file 80.8 s,
0 mismatches (details under the restore criterion). Redeployed api with the
fixed script: `scripts/deploy.sh HEAD api` at `e91463b`, deploy 92.6 s,
smoke 2.1 s, exit 0.

Process note: two guard checks (the deploy URL parser, the test-DB config)
were run by swapping a file in the repo and restoring it, not in a `/tmp` copy
as required; `git diff` was clean afterwards.

### Checks at `e54cd5c` (Node 24.21.0, clean worktree, no `.env` files)

| Check                                          | Result                                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| install `--frozen-lockfile`, `db:generate`     | ok                                                                                                                             |
| type-check                                     | 14/14 tasks                                                                                                                    |
| lint                                           | 14/14 tasks, 0 errors (web 56 and widget 2 warnings, pre-existing)                                                             |
| build                                          | 4/4 tasks, 0 cached                                                                                                            |
| `migrate:check` on a fresh migrated DB         | "No difference detected" (no migration changes in this phase)                                                                  |
| root `pnpm test` (Postgres, Redis, S3Mock), ×3 | 3/3 green, 11/11 tasks, 107/112/110 s; api 447, web 1251, core 288, jobs 114 + 1 skipped, database 42, contracts 18, widget 12 |
| ai: ruff, ruff format, mypy                    | clean; 81 files formatted; mypy 77 files                                                                                       |
| ai: pytest with the AI test DB                 | 234 passed, 1 skipped                                                                                                          |

Before the fix, at `6ca9d7a`, the same root run passed once and failed once
(jobs Stripe test timed out at 5.1 s while the other packages shared its DB).
E2E and visual suites were not rerun: nothing they cover changed.
