# Free demo environment

The free demo is the public link on the résumé. It uses only card-free
tiers and has no always-on server. Everything here was checked against the
vendor docs on 2026-07-16; limits marked **verify at signup** must be
confirmed when an account is created because vendors change them often.

## Accounts

| Service     | Plan                     | Why                                                     | Limits (verify at signup)                                                                               |
| ----------- | ------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Vercel      | Hobby                    | Hosts `web`, `api` (Express) and `ai` (Python) projects | Non-commercial use; functions 300 s max, 2 GB / 1 vCPU, 4.5 MB request/response body, 250 MB bundle     |
| Neon        | Free                     | Postgres 17 + pgvector                                  | Compute suspends between requests; storage, connection and compute limits vary by region                |
| Redis Cloud | Free 30 MB               | BullMQ queue store                                      | 30 MB, connection cap, TLS required; `noeviction`                                                       |
| Upstash     | QStash free + Redis free | Immediate job push for `api`; web rate limits           | QStash: 1,000 messages/day, 1 MB max message, 7-day max delay, 10 schedules, 15-min response, 3-day DLQ |
| Supabase    | Storage free             | S3-compatible object store for PDFs/reports             | Project pauses after inactivity; per-file and total quota limits vary                                   |
| Sentry      | Developer tier           | Error tracking                                          | 10% trace sampling, event quota limits                                                                  |
| Gemini API  | Free tier                | LLM + embeddings via OpenAI-compatible endpoint         | RPM/RPD/TPM per model; free-tier prompts may be used by Google to improve products                      |

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

# LLM
LLM_PROVIDER=gemini
LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
LLM_API_KEY=...
AI_CHAT_MODEL=...                 # see the Gemini note below
```

Gemini model note (2026-08-20): `gemini-2.5-flash` returns 404 for new API
users, so the default chat model cannot be used on a new key. Set the chat
model with `AI_CHAT_MODEL` to a model the key can use (the demo was
provisioned with a newer Flash model); if `AI_MODEL_ALLOWLIST` is set, it
must include that model or the service refuses to start.
Embeddings (`gemini-embedding-001`) work on a new key.

## Jobs

Immediate jobs (webhook fan-out, email, PDF render, AI indexing) are pushed
via QStash to `POST /jobs/run/:type` on the `api` project. The handler
verifies the `Upstash-Signature` JWT and runs the same processor a BullMQ
worker would.

Scheduled and batch jobs (recurring invoices, reminders, overdue, nightly
reports) run from `.github/workflows/jobs-drain.yml`. The workflow checks
out the repo, installs dependencies, and runs `pnpm --filter @wolff/api
worker:drain`, which starts a BullMQ worker against Redis Cloud, runs the
due schedulers, drains the queue, and exits. It runs every 15 minutes while
the repo is private and every 5 minutes once public. A monthly
`workflow_dispatch` or keep-alive commit avoids GitHub's 60-day auto-disable
for inactive scheduled workflows.

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
- Gemini free tier rate limits may require eval runs and embedding backfills
  to resume from checkpoints across multiple days.

## Local parity

Local development uses `docker compose up` for Postgres + pgvector and Redis.
The same code paths run; only the dispatcher changes (`bullmq` locally,
`qstash` in the demo).
