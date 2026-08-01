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

The `api` project uses Vercel's Express zero-config support: `apps/api/src/index.ts`
exports the Express app as default. Webhook routes receive the raw body via
`express.raw`. The function must not leak unhandled errors; the app's error
handler catches them.

## Environment variables

Each Vercel project needs the variables from its `.env.example`. The shared
ones are:

```bash
# Database
DATABASE_URL=neos://...          # Neon pooled URL for functions
DIRECT_URL=postgresql://...       # Neon direct URL for migrations

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

# Observability
SENTRY_DSN=...
OTEL_EXPORTER_OTLP_ENDPOINT=...

# LLM
LLM_PROVIDER=gemini
LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
LLM_API_KEY=...
```

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
