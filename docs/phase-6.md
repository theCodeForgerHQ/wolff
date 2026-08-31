# Phase 6: Operations (backups, rollback, alerts, runbook)

Branch `phase6-operations` from tag `phase6b-closed` (`1071935`). Nothing pushed.
Not yet reviewed; this is the author's record.

## Commits

| Commit               | What                                                                          |
| -------------------- | ----------------------------------------------------------------------------- |
| `1223531`            | fix(ai): answer HEAD on /healthz (the "wolff-ai down" false alarm)            |
| `02ceec1`            | feat(jobs): logical database export, restore and backup pruning               |
| `ecbe447`            | feat(jobs): S3 backup store with list, get and delete                         |
| `98d20f6`            | feat(jobs): nightly db.backup job on a QStash schedule                        |
| `9317124`            | feat(api): backup:restore script with per-table count comparison              |
| `bb5d2e5`            | feat(ops): one-command deploy with smoke tests and automatic rollback         |
| `3c43eda`            | feat(ops): Sentry alert workflows for new, regressed and spiking issues       |
| `0518e01`            | fix(ops): promote the new deployment when Vercel did not (found in the drill) |
| `2c2ebf5`, `d2d7c82` | docs(ops): runbook, then the other developer's gaps                               |

## Backup design (deviation from "pg_dump")

The design asks for a nightly `pg_dump`. A Vercel function has no Postgres client
binaries, there is no always-on host, and there is no pushed repo for a
GitHub Actions step. So `db.backup` is a **data-only logical export through
the app's own connection**: every table of `public` and `ai`, read in
500-row LIMIT/OFFSET batches in `ctid` order inside one REPEATABLE READ
transaction, gzipped NDJSON with per-table row counts in a header. Schema
comes from the migrations. Restore loads into an empty, migrated database in
foreign-key order. Rejected: a static `pg_dump` in the bundle (unpinned
binary, server-version match), Actions (no repo). Limits: the export has a
200 s budget and fails (no partial file) beyond it; sequences, roles and
grants are not in the file (the schema has no sequences today).

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
have tested the old deployment. Fixed in `0518e01` (test first: red, then
green); the restoring deploy of the tip then ran `api.promote` 5.2 s, smoke
1.8 s, and the flag is true again. Full three-project deploy of `bb5d2e5`:
3 m 32 s, all smoke tests passed.

### An alert fires and reaches the owner's email — partly met

- **UptimeRobot → ajayaditya.dev@gmail.com: met.** himalaya: 6984 "Monitor is
  DOWN: wolff-ai.vercel.app/healthz" (2026-08-23 16:33Z, root cause "HTTP 405 -
  Method Not Allowed") and 7009 "Monitor is UP: wolff-ai.vercel.app/healthz"
  (2026-08-30 01:03Z, one minute after the fixed ai went live). No deliberate
  break was made: the Chrome on 127.0.0.1:9333 was not running, so there was no
  dashboard access and no UptimeRobot API key was created.
- **Sentry: fires, does not reach Gmail.** Workflow `wolff: new or regressed
issue` (1346056) `lastTriggered` 01:02:22Z after a `sentry-cli send-event` at
  01:02:09Z; the second run saw it trigger again. But the only Sentry member
  is ajayaditya.dev@**proton.me**, and Gmail has never had mail from Sentry
  (`himalaya envelope search from sentry`: none). Owner item below.
- False alarm fix: the cause was not a cold start. UptimeRobot checks with HEAD,
  and FastAPI's GET route answered 405 (`curl -I`: ai 405, api 200). Fixed in
  `1223531`; monitor timeout unchanged; warm `/healthz` 0.7-1.0 s.

### The runbook followed end to end by the other developer — met for operations, not for setup from zero

The developer who had not written the runbook ran deploy (106 s, exit 0), backup,
restore (0 mismatches), PITR, the Sentry test, the alert script (updated, no
duplicates) and on-call checks: all passed. It reported 14 text gaps, fixed in
`d2d7c82`. Setup from zero and secret rotation were reviewed against the live
projects but not executed (would need new accounts / would rotate live secrets).

## Checks (Node 24.21.0, at `0518e01`; later commits are docs only)

- type-check: 14/14 tasks; lint: 0 errors (56 warnings, web, pre-existing); build 4/4.
- jobs with Postgres + Redis + S3Mock: 94 tests, 93 passed + 1 skipped after the
  scheduler-list update; api: 430 tests, 428 passed; the 2 failures
  (`invoices.test.ts` Razorpay link, `public.test.ts` no quote route) pass when
  the two files run alone (42/42); not investigated further, flaky under the full
  run. The local DB had to be migrated first (Docker was reset on 2026-08-30).
- deploy tests 15/15 (`src/deploy`); ai pytest 143 passed, 92 skipped (DB tests
  skipped: no AI test DB env); ruff, format, mypy clean.
- Tests bite: removing FK ordering or the keep-newest rule turns 4 backup tests
  red; removing the promote step turns its test red.

## Live changes

- Supabase private bucket `backups`; wolff-api env `BACKUP_BUCKET=backups`.
- QStash: 8 schedules (new `wolff-backup`, `0 21 * * *`).
- Sentry workflows 1346056, 1346057 (email to the org owner).
- Deployed: api, ai, web from `bb5d2e5`; api again from `0518e01` (current).
- Neon: 3 drill branches + 2 by the second operator created and deleted; only `main`.

## Owner items

1. Sentry alerts go to ajayaditya.dev@proton.me. To get them in Gmail: add and
   verify the Gmail address in Sentry (User settings -> Emails) and route
   project alerts to it, or change the account email. Then resend a test event.
2. Optional: a deliberate UptimeRobot down/up test (pause is silent; edit a
   monitor URL to a 404 path for 10 minutes), which needs dashboard access.
3. Neon schema-only branches are blocked by the legacy web access role
   `ai_reader`; the runbook works around it.
4. The backup files hold personal data and encrypted provider secrets in a
   private bucket; no extra encryption at rest beyond Supabase's.
