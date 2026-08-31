# Free demo environment

The free demo is the public link on the résumé. It uses only card-free
tiers and has no always-on server. Everything here was checked against the
vendor docs on 2026-07-16; limits marked **verify at signup** must be
confirmed when an account is created because vendors change them often.

## Accounts

| Service                       | Plan                     | Why                                                                                              | Limits (verify at signup)                                                                                                                                        |
| ----------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vercel                        | Hobby                    | Hosts `web`, `api` (Express) and `ai` (Python) projects                                          | Non-commercial use; functions 300 s max, 2 GB / 1 vCPU, 4.5 MB request/response body, 250 MB bundle                                                              |
| Neon                          | Free                     | Postgres 17 + pgvector                                                                           | Compute suspends between requests; storage, connection and compute limits vary by region                                                                         |
| Redis Cloud                   | Free 30 MB               | BullMQ queue store                                                                               | 30 MB, connection cap, TLS required; `noeviction`                                                                                                                |
| Upstash                       | QStash free + Redis free | Immediate job push for `api`; web rate limits                                                    | QStash: 1,000 messages/day, 1 MB max message, 7-day max delay, 10 schedules, 15-min response, 3-day DLQ                                                          |
| Supabase                      | Storage free             | S3-compatible object store for PDFs/reports                                                      | Project pauses after inactivity; per-file and total quota limits vary                                                                                            |
| Sentry                        | Developer tier           | Error tracking                                                                                   | 10% trace sampling, event quota limits                                                                                                                           |
| NVIDIA NIM (build.nvidia.com) | Free API key             | Chat (`nvidia/nemotron-3-super-120b-a12b`) and embeddings (`nvidia/nemotron-3-embed-1b`, 2048-d) | No published number (no docs page, no rate-limit headers, checked 2026-08-23); 40 RPM is the commonly reported per-account limit and is what the client enforces |
| Groq                          | Free plan                | Chat fallback (`openai/gpt-oss-120b`), no embeddings                                             | gpt-oss-120b: 30 RPM, 1,000 RPD, 8,000 TPM, 200,000 TPD (console.groq.com/docs/rate-limits, 2026-08-23; response headers agree)                                  |
| Gemini API                    | Free tier                | Optional; no longer the default (see below)                                                      | Gemini 3 Flash for a new key: 20 requests/day/model (observed 2026-08-20)                                                                                        |

## Vercel projects

Three projects from the same monorepo, each with its root directory set:

- `web` → `apps/web`
- `api` → `apps/api`
- `ai` → `services/ai` (created in Phase 5)

The `api` project deploys from `apps/api/vercel.json` as committed; no
build settings are set in the dashboard. Its build command bundles
`src/index.ts` with esbuild (`pnpm build:vercel`, script
`apps/api/scripts/bundle-vercel.mjs`) into `.vercel-bundle/index.mjs`: the
`@wolff/*` workspace packages, which export TypeScript sources, are compiled
into the bundle, and npm packages stay external for Vercel to trace. The
install uses pnpm's hoisted linker (`--config.node-linker=hoisted` in the
install command) because the bundle imports dependencies of the workspace
packages that pnpm's isolated layout hides from `apps/api`. Vercel's Express
preset then serves the bundle's default export. Checked locally with
`vercel build` (CLI 62.2.0): the function handler is the bundle, and the
built function directory answers `/healthz` and `/readyz` on its own. The bundle has no source map, and `build:vercel` fails if anything but
`index.mjs` is in `.vercel-bundle`; after a local `vercel build`,
`pnpm --filter @wolff/api check:vercel-output` fails if any `.js`/`.mjs`/`.map`
is in `.vercel/output/static`, a source map is in a function, or the handler
is not the bundle. Do not
set `NODE_ENV` on the project: the install then skips devDependencies, and
esbuild is one.

Webhook routes receive the raw body via `express.raw`. The function must not
leak unhandled errors; the app's error handler catches them, and it waits
(up to 2 s) for the Sentry event to be sent before answering, because Vercel
freezes the function once the response is out.

Request logs keep the path only: query strings (the Vercel protection bypass
on webhook URLs) and the Vercel bypass/OIDC headers are not logged.

## Environment variables

Each Vercel project needs the variables from its `.env.example`. The shared
ones are:

```bash
# Database
DATABASE_URL=postgresql://...?sslmode=require   # Neon pooled URL for functions
DIRECT_URL=postgresql://...?sslmode=require     # Neon direct URL for migrations
# AI service: one standard URL serves Alembic (psycopg) and the service
# (asyncpg). sslmode is translated for asyncpg: verify-full/verify-ca become
# a verifying SSL context, require stays require, channel_binding is dropped,
# and an unknown sslmode is an error. Neon's copied URL works unchanged.
AI_DATABASE_URL=postgresql://ai_service:...@...?sslmode=require

# Redis / queue
REDIS_URL=rediss://...            # Redis Cloud, TLS on
JOB_DISPATCHER=qstash             # demo uses push, not a resident worker

# QStash
QSTASH_TOKEN=...
QSTASH_CURRENT_SIGNING_KEY=...
QSTASH_NEXT_SIGNING_KEY=...
PUBLIC_API_URL=https://api-...vercel.app

# Storage
STORAGE_PROVIDER=s3
STORAGE_ENDPOINT=https://<ref>.supabase.co/storage/v1/s3
STORAGE_BUCKET=...
STORAGE_REGION=eu-west-1          # Supabase S3 endpoint region
STORAGE_ACCESS_KEY=...
STORAGE_SECRET_KEY=...

# Email
RESEND_API_KEY=...
EMAIL_FROM=...
# Demo: every email (web sends and job emails) goes to DEMO_EMAIL_REDIRECT,
# with the intended recipients in the subject. web and api refuse to start
# with DEMO_MODE=true and no valid redirect. Use the Resend account's own
# address: Resend's shared onboarding sender delivers only there.
DEMO_MODE=true
DEMO_EMAIL_REDIRECT=owner@...

# Observability
SENTRY_DSN=...
OTEL_EXPORTER_OTLP_ENDPOINT=...

# LLM (services/ai, the wolff-ai project)
LLM_PROVIDER=nvidia               # chat + embeddings
LLM_FALLBACK=groq                 # chat only, tried when NIM fails as a provider
NVIDIA_API_KEY=...
GROQ_API_KEY=...
AI_MAX_TOKENS=4096                # reasoning models spend tokens before answering
AI_DAILY_BUDGET_USD=1.00          # per workspace per day, nominal prices
```

One key per provider, no pooling. The client's limits per provider are in
`services/ai/app/llm/providers.py` (NIM 40 RPM / our 5,000 RPD ceiling /
2 concurrent; Groq 30 RPM / 1,000 RPD / 8,000 TPM). Each provider has its
own rate-limited transport, and both are charged to the same per-workspace
daily budget. Embeddings never fall back: vectors from two models are not
comparable.

Models probed on 2026-08-23 with a one-tool request: NIM
`nemotron-3-super-120b-a12b` and `nemotron-3-nano-omni-30b-a3b-reasoning`,
Groq `openai/gpt-oss-120b` and `qwen/qwen3.8-27b` called the tool. NIM lists
`llama-3.1-nemotron-70b-instruct`, `llama-3.1-nemotron-ultra-253b-v1` and the
embedding models `nv-embedqa-mistral-7b-v2`, `llama-3.2-nv-embedqa-1b-v1`,
`embed-qa-4`, `snowflake/arctic-embed-l`, but they answer 404 "Function not
found for account". `nemotron-3-embed-1b` serves 2048 dimensions only
(`dimensions` 1536 or 1024 is refused) and is asymmetric: documents are
embedded with `input_type=passage`, searches with `query`. The column is
`halfvec(2048)` (Alembic 0002), because pgvector's HNSW index takes `vector`
only up to 2000 dimensions.

Gemini (2026-08-20): every model a new key can use is a Gemini 3 thinking
model; its tool calls need thought signatures that langchain-openai drops,
and the free quota is 20 requests a day. It stays selectable
(`LLM_PROVIDER=gemini`) for embeddings and plain chat.

## Jobs

Immediate jobs (webhook fan-out, email, PDF render, AI indexing) are pushed
via QStash to `POST /jobs/run/:type` on the `api` project. The handler
verifies the `Upstash-Signature` JWT and runs the same processor a BullMQ
worker would.

Scheduled jobs come from QStash schedules (owner decision 2026-08-23; a
deviation from the design, see docs/phase-2.md). QStash calls the same
signed `POST /jobs/run/:type` route on its own, so nothing runs outside
Vercel. The schedules are defined in `QSTASH_SCHEDULES`
(`packages/jobs/src/qstash.ts`) and created or updated with:

```bash
QSTASH_TOKEN=... PUBLIC_API_URL=https://<api> pnpm --filter @wolff/api schedules:sync
```

| Schedule (`wolff-*`) | Job                                                                     | Cron (UTC)           |
| -------------------- | ----------------------------------------------------------------------- | -------------------- |
| outbox-sweep         | `outbox.sweep`: requeue stale events, relay due ones (emails, webhooks) | `*/15 * * * *`       |
| automations          | `automations.tick`                                                      | `7,22,37,52 * * * *` |
| recurring            | `recurring.generate`                                                    | `0 * * * *`          |
| ai-sweep             | `ai.sweep`: re-embed what changed, bounded batches                      | `30 * * * *`         |
| reminders            | `reminders.scan`                                                        | `0 3 * * *`          |
| overdue              | `invoices.mark_overdue`                                                 | `15 0 * * *`         |
| reports-nightly      | `reports.nightly`                                                       | `30 20 * * *`        |
| backup               | `db.backup`: logical export to the `backups` bucket, 14-day retention   | `0 21 * * *`         |

8 of the free tier's 10 schedules, about 246 messages a day of 1,000. Every
job must end inside Vercel's 300 s limit: the outbox sweep relays at most
200 events per run, and the AI sweep stops starting calls after 200 s, each
call embedding at most 25 sources in at most about 40 s; the rest is picked
up by the next run.

`.github/workflows/jobs-drain.yml` (`worker:drain` against Redis Cloud) is
kept as a manual workflow for a deployment that queues on Redis without a
worker.

## Migrations

Run migrations from a GitHub Actions workflow or local machine with
`DIRECT_URL` pointing at Neon:

```bash
pnpm --filter @wolff/database migrate:deploy
# Phase 5 AI schema (when services/ai exists):
cd services/ai && uv run alembic upgrade head
```

## Known free-tier constraints

- Neon compute suspends between requests: cold-start latency on first hit.
- Supabase free projects pause after inactivity; a `pg-bytea` fallback
  driver exists in `packages/jobs/src/ports/storage.ts` for demo scale.
- Redis Cloud 30 MB is enough for ids-only job payloads and short queues.
- QStash 1,000 messages/day limits how many webhooks/emails/PDFs can be
  triggered; the outbox keeps every event and the drain reconciles missed
  ones.
- Free LLM limits: a full re-embed and the 84-item eval are spread over
  several sweep runs / eval runs that resume.

## Local parity

Local development uses `docker compose up` for Postgres + pgvector and Redis.
The same code paths run; only the dispatcher changes (`bullmq` locally,
`qstash` in the demo).
