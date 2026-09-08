# Runbook: the free demo (Wolff)

Operations for the demo on Vercel, Neon, Supabase, Upstash, Redis Cloud,
Sentry and UptimeRobot. Free plans only: never add a payment method or
upgrade a plan. No secret value belongs in this file or in git; secrets live
in Vercel project env vars and in the operator's own secrets file (called
`secrets.env` below, `chmod 600`, outside the repo; on the owner's machine it is
`../secrets.env` from the repo root).

Conventions: commands run from the repo root on Node 24 with
`npx -y pnpm@9.15.0`. `psql` can be `docker run --rm postgres:17 psql`.
Load secrets into a shell with `set -a; source secrets.env; set +a` and never
`echo` them.

## 0. Map

| Piece                   | Where                                                                               | Notes                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| web (Next.js)           | Vercel `wolff-web`, root `apps/web`, <https://wolff-web.vercel.app>                 | Behind Vercel Authentication; automation bypass `VERCEL_BYPASS_WEB`                  |
| api (Express)           | Vercel `wolff-api`, root `apps/api`, <https://wolff-api.vercel.app>                 | Public; `/healthz`, `/readyz`; signed `/jobs/run/:type`                              |
| ai (FastAPI)            | Vercel `wolff-ai`, deployed from `services/ai` alone, <https://wolff-ai.vercel.app> | Public; `/healthz` (GET and HEAD)                                                    |
| Postgres                | Neon project `wolff-demo` (`patient-rice-66047365`), branch `main`, db `neondb`     | Free: 6 h point-in-time history (`history_retention_seconds` 21600, read 2026-08-30) |
| Object storage          | Supabase `wolff-demo`: private buckets `pdfs` and `backups`                         | S3 API, keys in `STORAGE_*`                                                          |
| Scheduled + pushed jobs | Upstash QStash, 8 schedules `wolff-*`                                               | see docs/free-tier.md "Jobs"                                                         |
| Queue store             | Redis Cloud 30 MB                                                                   | only for `worker:drain`                                                              |
| Rate limits             | Upstash Redis                                                                       | web only                                                                             |
| Errors                  | Sentry org `ajayaditya` (EU, `de.sentry.io`), projects `wolff-web/api/ai`           | alert workflows from `scripts/sentry-alerts.py`                                      |
| Uptime                  | UptimeRobot, 3 HTTP monitors, 5 min, email                                          | api `/readyz`, ai `/healthz`, web `/login`                                           |

Vercel team id `team_l9AdIJOw3H9DJEt9eMVOJBL8`, scope
`ajayaditya-codes-projects`; project ids: web
`prj_LxlAp8yvPjqqnwQ2383so0Kondn4`, api `prj_7WXTAZVnggX00vg6rHSVwZ8hSxET`, ai
`prj_WvGsU7Ft4waFLdHCr09Eze3xnmHL`.

## 1. Set up from zero

Order matters: database, storage, queues, then the three projects, then
schedules and monitors. Every step uses a free plan that needs no card.

1. **Neon.** Create project `wolff-demo` (Postgres 17, aws-us-east-1). Enable
   pgvector. Keep the pooled URL (`DATABASE_URL`) and the direct URL
   (`DIRECT_URL`). Create the AI roles: `psql "$DIRECT_URL" -f infra/db/bootstrap.sql`
   (set the `ai_service` password afterwards). Migrate:
   `DIRECT_URL=... DATABASE_URL=... npx -y pnpm@9.15.0 --filter @wolff/database migrate:deploy`,
   then `cd services/ai && AI_DATABASE_URL=... uv run alembic upgrade head`.
   Seed if wanted: `pnpm db:seed` then `seed:demo` (set `DATABASE_POOL_MAX=50`
   from far away; see docs/free-tier.md).
2. **Supabase.** Create project `wolff-demo`; Storage: private buckets `pdfs`
   and `backups` (the REST call: `POST $SUPABASE_URL/storage/v1/bucket` with the
   service-role key, body `{"id":"backups","name":"backups","public":false}`).
   Dashboard -> Storage -> S3 Connection -> create access keys (no API).
3. **Upstash.** QStash: copy `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`,
   `QSTASH_NEXT_SIGNING_KEY`. Redis: REST URL and token for web.
4. **Redis Cloud.** Free 30 MB database, TLS, `noeviction`; `REDIS_URL` (`rediss://`).
5. **Sentry.** Three projects (`wolff-web` javascript-nextjs, `wolff-api`
   node-express, `wolff-ai` python-fastapi); their DSNs. An org auth token
   with `alerts:write` and `org:read` as `SENTRY_AUTH_TOKEN`, then
   `python3 scripts/sentry-alerts.py` (section 6).
6. **Vercel.** Three Hobby projects (table above: root directory and preset).
   Set env vars per project; the names each one needs are in its
   the lists below (only web has an `.env.example`; docs/free-tier.md
   explains the shared ones):
   - api: `DATABASE_URL APP_URL PUBLIC_API_URL WEB_ORIGIN JOB_DISPATCHER=qstash QSTASH_* REDIS_URL STORAGE_PROVIDER=s3 STORAGE_ENDPOINT STORAGE_REGION STORAGE_BUCKET=pdfs STORAGE_ACCESS_KEY STORAGE_SECRET_KEY BACKUP_BUCKET=backups BACKUP_ENCRYPTION_KEY STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_CONNECT_WEBHOOK_SECRET SVC_JWT_SECRET_{WEB,AI,WORKER,LAMBDA} AI_URL ENCRYPTION_KEY RESEND_API_KEY EMAIL_FROM DEMO_MODE DEMO_EMAIL_REDIRECT SENTRY_DSN SENTRY_TRACES_SAMPLE_RATE LOG_LEVEL WEB_PROTECTION_BYPASS`. Do not set `NODE_ENV`.
   - web: `DATABASE_URL AUTH_SECRET NEXTAUTH_SECRET NEXTAUTH_URL AUTH_TRUST_HOST API_V1_UPSTREAM AI_URL SVC_JWT_SECRET_WEB ENCRYPTION_KEY CRON_SECRET STRIPE_SECRET_KEY NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY STORAGE_PROVIDER STORAGE_ENDPOINT STORAGE_REGION STORAGE_BUCKET STORAGE_ACCESS_KEY STORAGE_SECRET_KEY UPSTASH_REDIS_REST_* RESEND_API_KEY EMAIL_FROM DEMO_* GOOGLE_CLIENT_* SENTRY_DSN SENTRY_TRACES_SAMPLE_RATE NEXT_PUBLIC_SENTRY_DSN NEXT_PUBLIC_APP_*`.
   - ai: `AI_DATABASE_URL` (psycopg URL with `sslmode=require`), `LLM_PROVIDER=nvidia LLM_FALLBACK=groq NVIDIA_API_KEY GROQ_API_KEY GEMINI_API_KEY (optional) AI_MAX_TOKENS AI_DAILY_BUDGET_USD API_INTERNAL_URL AI_PUBLIC_URL AI_REPORTS_DIR=/tmp/reports SVC_JWT_SECRET_{AI,WEB,WORKER} SENTRY_DSN SENTRY_TRACES_SAMPLE_RATE ENVIRONMENT=production PRODUCT_SLUG=wolff`.
     Turn Vercel Authentication on for web only; create its Protection Bypass for
     Automation secret (`VERCEL_BYPASS_WEB`, also the api's `WEB_PROTECTION_BYPASS`).
7. **Deploy** with section 2.
8. **Schedules:** `QSTASH_TOKEN=... PUBLIC_API_URL=https://wolff-api.vercel.app npx -y pnpm@9.15.0 --filter @wolff/api schedules:sync`
   (expect "Synced 8 schedules").
9. **Webhooks:** Stripe endpoints to `https://wolff-api.vercel.app/webhooks/stripe`
   and `/webhooks/stripe/connect`; Razorpay to `/webhooks/razorpay/<workspace id>`.
10. **UptimeRobot:** HTTP(s) monitors on api `/readyz`, ai `/healthz`, web
    `/login`, 5-minute interval, email alert contact. The free monitor checks
    with HEAD; every monitored route must answer HEAD (ai answered 405 until
    `7646fcc`, which UptimeRobot reported as down).
11. **Check:** section 7's list, then trigger one backup (section 4.1).

## 2. Deploy

```bash
set -a; source ../secrets.env; set +a   # adjust to where your file is
export VERCEL_TEAM_ID=team_l9AdIJOw3H9DJEt9eMVOJBL8 VERCEL_SCOPE=ajayaditya-codes-projects \
  VERCEL_PROJECT_API=prj_7WXTAZVnggX00vg6rHSVwZ8hSxET \
  VERCEL_PROJECT_AI=prj_WvGsU7Ft4waFLdHCr09Eze3xnmHL \
  VERCEL_PROJECT_WEB=prj_LxlAp8yvPjqqnwQ2383so0Kondn4
scripts/deploy.sh            # HEAD, all three: api, then ai, then web
scripts/deploy.sh HEAD api   # one project
scripts/deploy.sh v1.2 api   # a ref, one project
```

It needs the `vercel` CLI logged in (or `VERCEL_TOKEN`) and `VERCEL_BYPASS_WEB`.
It deploys from a `git archive` of the ref (never the working tree: the CLI
would upload `.env` files), promotes the new deployment if Vercel did not
assign the production domain, smoke-tests the production URL (api
`/healthz` + `/readyz` database up; ai `/healthz` GET and HEAD; web `/login`
through the bypass; 4 tries, 5 s apart), and prints a JSON result with
timings. Exit 0 means every project is live and healthy.

Commit only what you deploy; the archive is the commit. Migrations are not
run by the script: before a release with a migration, take a Neon branch
snapshot (section 4.3), then run `migrate:deploy` against `DIRECT_URL`, then
deploy.

### 2.1 Releasing the 2026-09-04 fixes

The reliability and security fixes of 2026-09-04 (branches
`fix-security-review` and `fix-reliability`) need, in this order:

1. **Neon snapshot** (section 4.3).
2. **Prisma migration** `20260904120000_automation_run_unique_subject`
   (`migrate:deploy` against `DIRECT_URL`). It deletes duplicate automation
   runs (keeping the oldest of each automation and subject) before adding
   the unique index.
3. **Alembic** `0003` in `services/ai` (`uv run alembic upgrade head` with
   the AI service's direct URL): adds `attempts` to `ai.ingest_state`. The new
   ai code reads it, so run this before deploying ai.
4. **Deploy** api, ai, web (`scripts/deploy.sh`).
5. **Re-sync the QStash schedules** (`schedules:sync`, section 1 step 8).
   This replaces the eight old schedules with four, all at minute 0
   (`wolff-tick` hourly, ai-sweep daily, reports nightly, backup weekly) and
   deletes the retired ones. Until it runs, the old schedules keep firing.
6. **Check**: the next hour's `wolff-tick` delivery in the QStash console
   answers 200, and Neon's compute graph shows it suspending between hours.

Self-hosting only: set `TRUSTED_PROXY_HOPS` to the number of reverse proxies
in front of the web app (default 1), and make the web port reachable only
through them; rate limits key on the address they report.

## 3. Roll back

**Automatic.** When a smoke test or a deploy fails, the script runs
`vercel rollback` for every project it promoted in that run, newest first, to
the production deployment it recorded before the run, then repeats the
checks and reports `"recovered": true|false`. Exit code 1.

**Manual:**

```bash
vercel rollback <previous deployment URL> --yes --scope ajayaditya-codes-projects  # with VERCEL_ORG_ID/VERCEL_PROJECT_ID set
```

Find the URL with `vercel ls wolff-api --scope ...` or in the dashboard.
Hobby can only roll back to the deployment immediately before.

**After any rollback** Vercel stops assigning the production domain to new
deployments (`autoAssignCustomDomains=false` on the project). The deploy
script handles it (it promotes); by hand, run `vercel promote <url>` on the
next good deployment.

Drill (2026-08-30): a commit whose `/readyz` answered 500 went live at
01:09:18Z; the smoke test failed after 18.5 s of retries; `vercel rollback`
took 5.8 s; `/readyz` was 200 again at 01:09:42Z. Details: docs/phase-6.md (Phase 6 record).

## 4. Backups and restore

### 4.1 Weekly backup

QStash schedule `wolff-backup` (`0 21 * * 0` UTC, weekly since 2026-09-04:
a full export is the heaviest job there is) calls `db.backup` on the api. It exports every table of the `public` and `ai` schemas, data only, in
one REPEATABLE READ snapshot, except the migration history and the RAG index
(section 4.2). The rows stream through gzip and AES-256-GCM into
`backups/db/<UTC date>.ndjson.gz.enc` as a multipart upload; then files older
than `BACKUP_RETENTION_DAYS` (14; never the newest) are deleted. The schema is
not in the file: it comes from the migrations. Why not `pg_dump`:
docs/phase-6.md, "Backup design".

**The encryption key.** `BACKUP_ENCRYPTION_KEY` (32 random bytes, base64,
`openssl rand -base64 32`) is set on wolff-api and kept in the owner's
`secrets.env`, outside the repo. It is never logged. **Losing it makes every
backup unrecoverable**: there is no other copy and no way around GCM. Keep a
second copy in a password manager. The api refuses to start with
`BACKUP_BUCKET` set and no key, or a malformed key. Storage access uses the
same `STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY` as the PDFs (Supabase S3 keys
are project-wide); the encryption is what keeps a leaked storage key from
exposing the data. To rotate the key: set the new one, take a backup, and
keep the old key until the last file written with it has been pruned (14 days).

Run one now (does nothing if today's file exists):

```bash
curl -s -X POST "$QSTASH_URL/v2/publish/https://wolff-api.vercel.app/jobs/run/db.backup" \
  -H "Authorization: Bearer $QSTASH_TOKEN" -H 'content-type: application/json' \
  -d '{"type":"db.backup","payload":{},"jobId":"manual:backup"}'
```

List backups:

```bash
curl -s "$SUPABASE_URL/storage/v1/object/list/backups" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H 'content-type: application/json' -d '{"prefix":"db","limit":100}'
```

A failed run shows as a QStash delivery that is not 200 (QStash console, or
`GET $QSTASH_URL/v2/events?messageId=...`) and as a Sentry issue on wolff-api.

### 4.2 Restore from a backup

The target must have the schema and no rows. On Neon free, schema-only
branches are refused for this project ("legacy web access role"), so:

```bash
P=patient-rice-66047365
psql() { docker run --rm postgres:17 psql "$@"; }   # if psql is not installed
B=$(neonctl branches create --project-id $P --name restore-$(date +%m%d) --output json | jq -r .branch.id)  # copy of main
URL=$(neonctl connection-string $B --project-id $P --database-name neondb --role-name neondb_owner)
# Empty it, except the migration history (_prisma_migrations, alembic_version):
# backups leave those tables out and the restore keeps the target's own.
# public: TRUNCATE as neondb_owner. ai: tables belong to ai_owner, and
# neondb_owner cannot SET ROLE to it, but may DELETE.
psql "$URL" -c "DO \$\$ DECLARE l text; BEGIN SELECT string_agg(format('%I.%I',schemaname,tablename),', ') INTO l FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'; EXECUTE 'TRUNCATE '||l; END \$\$;"
psql "$URL" -c "DO \$\$ DECLARE r record; BEGIN FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='ai' AND tablename <> 'alembic_version' LOOP EXECUTE format('DELETE FROM ai.%I', r.tablename); END LOOP; END \$\$;"
( cd apps/api && RESTORE_TARGET_URL="$URL" BACKUP_BUCKET=backups \
  node --import tsx scripts/restore-backup.ts )   # newest; or pass a key, e.g. db/2026-08-30.ndjson.gz.enc
neonctl branches delete $B --project-id $P       # when done
```

`BACKUP_ENCRYPTION_KEY`, `STORAGE_ENDPOINT`, `STORAGE_REGION`,
`STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY` must be in the environment. A wrong
key or a damaged file fails authentication and the restore loads nothing (it
runs in one transaction). The script prints backup vs restored rows per
table and exits 1 on any mismatch. To a fresh database instead of a branch:
run the migrations (section 1 step 1) and the restore; nothing to empty. The
backup has no migration history, so the migrations' own history rows stay.

The RAG index is not in the backup: `ai.document_chunks` (the 2048-dimension
embeddings, most of the bytes) and `ai.ingest_state` are left out because they
can be rebuilt (`REBUILDABLE_TABLES` in `packages/jobs/src/backup.ts`). After a
restore both are empty, so the hourly `ai.sweep` schedule (minute 30) finds
every quote, invoice, contract and client note unindexed and embeds it again,
in batches inside its 200 s budget. To start it now instead of waiting:

```bash
curl -s -X POST "$QSTASH_URL/v2/publish/https://wolff-api.vercel.app/jobs/run/ai.sweep" \
  -H "Authorization: Bearer $QSTASH_TOKEN" -H 'content-type: application/json' \
  -d '{"type":"ai.sweep","payload":{},"jobId":"manual:ai-sweep"}'
```

Until it has run, AI search and chat answer without context from the restored
documents; nothing else depends on the index.

To make a restored branch the live database: point `DATABASE_URL` (web, api)
and `AI_DATABASE_URL` (ai) at it, or use Neon's "restore branch" on `main`,
and redeploy. Delete scratch branches afterwards
(`neonctl branches delete $B --project-id $P`).

Drill (2026-08-30, encrypted format 2): 61 tables, 1,376 rows, 0 mismatches,
migration history kept; branch 5.9 s, emptying 12.8 s, restore 80.8 s
(download and load stream together), delete 3.6 s. The backup file was
150,077 bytes.

### 4.3 Point-in-time restore (Neon)

Free plan history: 6 hours. Inside it:

```bash
T=$(date -u -v-1H +%FT%TZ)   # GNU date: date -u -d '1 hour ago' +%FT%TZ
B=$(neonctl branches create --project-id $P --name pitr-$(date +%m%d) --parent $T --output json | jq -r .branch.id)
URL=$(neonctl connection-string $B --project-id $P --database-name neondb --role-name neondb_owner)
psql "$URL" -Atc "select max(created_at) from public.quote_events"   # must be earlier than $T
neonctl branches delete $B --project-id $P
```

Compare the query with the same one on `main` (a later value there shows the branch is the past). Then either use it (as above) or
delete it. Before a migration, a branch of `main` _now_ is the snapshot.
Drill: create 3.9 s, first query 2.9 s, delete 3.5 s.

## 5. Rotate secrets

General order: create the new value, set it where it is read, redeploy the
readers (`scripts/deploy.sh HEAD <projects>`), check, then revoke the old one
and update `secrets.env`. Per project, export `VERCEL_ORG_ID` (team id) and `VERCEL_PROJECT_ID` (section 0)
in an empty directory (or run `vercel link` there), then `vercel env ls`,
`vercel env rm NAME production` and `vercel env add NAME production`. Without
them `vercel env ls` prints nothing.

| Secret                                             | Where it is read                                                       | How to rotate                                                                                                                                                                                                   | Notes                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Neon `neondb_owner` password                       | `DATABASE_URL` web, api                                                | Neon console or `neonctl roles reset-password`; update both; redeploy web, api                                                                                                                                  | Old connections drop                                  |
| Neon `ai_service` password                         | `AI_DATABASE_URL` ai                                                   | `ALTER ROLE ai_service PASSWORD ...` as owner; redeploy ai                                                                                                                                                      |                                                       |
| `AUTH_SECRET` / `NEXTAUTH_SECRET`                  | web                                                                    | `openssl rand -base64 32`; redeploy web                                                                                                                                                                         | Signs everyone out                                    |
| `ENCRYPTION_KEY`                                   | web, api                                                               | **Do not just replace.** Stored provider secrets (Razorpay keys, webhook secrets) are encrypted with it; re-encrypt them with the new key first, or re-enter them in the app after. Keep the old key until done | Losing it makes those secrets unreadable              |
| `SVC_JWT_SECRET_{WEB,WORKER,AI,LAMBDA}`            | issuer and verifier: WEB on web+api+ai, WORKER on api+ai, AI on api+ai | new value on both sides, redeploy both together                                                                                                                                                                 | Calls fail between the two deploys                    |
| `CRON_SECRET`                                      | web                                                                    | new value; redeploy web                                                                                                                                                                                         |                                                       |
| QStash signing keys                                | api                                                                    | QStash console "Roll signing keys": the next key becomes current; set both on api, redeploy                                                                                                                     | Verifier accepts current and next, so no gap          |
| `QSTASH_TOKEN`                                     | api (+ schedules:sync)                                                 | Upstash console reset; set on api; redeploy                                                                                                                                                                     |                                                       |
| Upstash Redis REST token                           | web                                                                    | console reset; redeploy web                                                                                                                                                                                     |                                                       |
| `REDIS_URL` password                               | api                                                                    | Redis Cloud console; redeploy api                                                                                                                                                                               |                                                       |
| Supabase S3 keys (`STORAGE_ACCESS_KEY/SECRET_KEY`) | web, api                                                               | create a new pair in the dashboard, set, redeploy, delete the old pair                                                                                                                                          |                                                       |
| `SUPABASE_SERVICE_ROLE_KEY`                        | operator only (bucket admin)                                           | Supabase "rotate JWT secret" (rotates anon keys too)                                                                                                                                                            | Not on Vercel                                         |
| Stripe secret key                                  | web, api                                                               | Stripe dashboard (test mode) roll key; set; redeploy                                                                                                                                                            |                                                       |
| Stripe webhook secrets                             | api `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET`           | "Roll secret" on each endpoint (Stripe keeps the old one valid for a window); set; redeploy api                                                                                                                 |                                                       |
| Razorpay keys / webhook secret                     | per workspace, encrypted in the DB                                     | enter in the app's payment settings                                                                                                                                                                             | Not env vars                                          |
| Resend API key                                     | web, api                                                               | new key, set, redeploy, delete old                                                                                                                                                                              |                                                       |
| Google OAuth client secret                         | web                                                                    | Google Cloud console: add secret, set, redeploy, disable old                                                                                                                                                    |                                                       |
| `NVIDIA_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY` | ai                                                                     | new key on the provider; set; redeploy ai                                                                                                                                                                       |                                                       |
| Sentry DSNs                                        | all three                                                              | Sentry project -> Client Keys: new key, set, redeploy, disable old                                                                                                                                              | DSNs are not secret in browsers, but rotate if abused |
| `SENTRY_AUTH_TOKEN`                                | operator only                                                          | Sentry -> Auth Tokens: new, revoke old                                                                                                                                                                          |                                                       |
| Vercel bypass (`VERCEL_BYPASS_WEB`)                | operator, api `WEB_PROTECTION_BYPASS`                                  | Vercel project -> Deployment Protection -> regenerate; set on api; redeploy api                                                                                                                                 |                                                       |
| Demo API keys (`wolff_sk_...`)                     | DB (hashed)                                                            | revoke and create in the app                                                                                                                                                                                    |                                                       |

After rotating, run section 7's checks.

## 6. Alerts

- **Sentry:** `SENTRY_AUTH_TOKEN=... python3 scripts/sentry-alerts.py` creates
  or updates two workflows on the three issue streams: "new or regressed
  issue" and "error spike (>10 events of an issue in 1h)", both emailing the
  org owner's Sentry login address. Test: `SENTRY_DSN=$SENTRY_DSN_API sentry-cli send-event -m "alert test $(date)" --level error`
  creates a new issue; the workflow's `lastTriggered` (GET
  `organizations/ajayaditya/workflows/`) updates within a minute:
  `curl -s -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" https://de.sentry.io/api/0/organizations/ajayaditya/workflows/`.
  The org is in the EU region (`de.sentry.io`); sentry-cli may warn that its
  config points at `sentry.io`, harmless for `send-event` with a DSN. Sentry's
  own default "high priority issues" workflows also fire, so a test can send
  more than one email. The script prints the owner's email address; redact it
  before sharing logs.
- **Usage, before the hard limits:** the September 2026 outage was silent
  for days. Neon's free compute quota ran out on 09-03 (every job failed
  with `53000`), and the failing invocations then used up Vercel's
  fair-use CPU allowance: the team was blocked (402 `DEPLOYMENT_DISABLED`)
  from 09-04, with Vercel's automatic unblock a month later. Check both
  dashboards weekly (Neon: Usage, compute hours; Vercel: Usage, Fluid
  Active CPU), and treat a run of Sentry errors with one cause as an outage,
  not as noise. A job failing because the database is down now logs one
  warning and answers 503 instead of reporting each failure.
- **UptimeRobot:** emails on down and up. A false "down" usually means the
  monitor's HEAD request is not answered (405) or the URL is behind Vercel
  Authentication; check with `curl -I <url>`.

## 7. On-call checklist

When an alert arrives:

1. Which service? `curl -s -w ' %{http_code}\n' https://wolff-api.vercel.app/readyz`,
   `curl -sI https://wolff-ai.vercel.app/healthz`,
   `curl -s -o /dev/null -w '%{http_code}\n' -H "x-vercel-protection-bypass: $VERCEL_BYPASS_WEB" https://wolff-web.vercel.app/login`.
2. Was there a deploy in the last hour? `vercel ls <project> --scope ...`. If
   yes and it is the cause: roll back (section 3).
3. `/readyz` 503 with `database: down`: Neon status page, Neon console (compute
   suspended? quota?). Free compute hours or storage exhausted -> see section 8.
4. Read the error: Sentry issue, then `vercel logs <deployment url>`.
5. Jobs: QStash console -> Logs / DLQ. Failed deliveries retry 3 times, then
   land in the DLQ (3 days). Republish from the DLQ after the fix.
   `outbox_events` with status `pending` for a long time means the outbox
   sweep is not running.
6. Storage: Supabase project paused after inactivity? Restore it from the
   dashboard (free projects pause; a paused project fails PDF and backup jobs).
7. Data loss or corruption: stop writes if needed (roll back), then PITR (4.3)
   within 6 h, otherwise the newest backup (4.2).
8. Write down what happened, the timeline and the fix.

Daily glance: last night's `backups/db/<date>.ndjson.gz.enc` exists; QStash shows
no failed deliveries; Sentry has no new unresolved issues.

## 8. Free-tier limits (as checked; vendors change them)

| Service           | Limit that matters                                                                                                       | Consequence here                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Vercel Hobby      | 300 s per function, 4.5 MB body, 250 MB bundle (Python 500 MB), non-commercial; rollback only to the previous deployment | jobs are bounded batches; backup export budget 200 s                              |
| Neon Free         | compute suspends when idle; 6 h history (read 2026-08-30); schema-only branches refused on this project                  | first request after idle is slow; restore drill uses a copied then emptied branch |
| Supabase Free     | project pauses after inactivity; 50 MB per file upload                                                                   | a backup is ~1.2 MB gzipped today                                                 |
| QStash Free       | 1,000 messages/day, 10 schedules, 1 MB message, DLQ 3 days                                                               | 8 schedules, ~246 messages/day before job fan-out                                 |
| Redis Cloud       | 30 MB                                                                                                                    | drains only                                                                       |
| Upstash Redis     | free daily command cap                                                                                                   | web rate limits only                                                              |
| Sentry Developer  | one user, event quota                                                                                                    | alerts email the single owner login                                               |
| UptimeRobot Free  | 5-minute interval, HEAD checks                                                                                           | alert can lag an outage by up to 5 min                                            |
| NVIDIA NIM / Groq | ~40 RPM / 30 RPM, 1,000 RPD, 8,000 TPM                                                                                   | see docs/free-tier.md                                                             |

Full list with sources: docs/free-tier.md.
