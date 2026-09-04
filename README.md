# Quote-to-cash for agencies and freelancers

Lead → deal → quote → e-signature → GST invoice → payment (Stripe or Razorpay) →
reports, with an AI assistant that answers questions over your own documents,
drafts quotes, and can be driven from any MCP client.

The app is an open-source quote and invoice tool (AGPL-3.0) with
a CRM, an Indian
GST engine, Razorpay, a public REST API with webhooks, background jobs, an
embeddable widget, a Python AI service, and the operations around a free hosted
demo. It is a portfolio project: every number below was measured, and each
comes with its caveats.

**Who it is for:** small agencies and freelancers, in India and elsewhere, who
quote, invoice and get paid, and want to own their data.

- [Architecture](#architecture) · [Features](#features) · [Tech stack](#tech-stack)
- [How it's built](#how-its-built) · [Measured](#measured) · [Quick start](#quick-start)
- [Tests and CI](#tests-and-ci) · [Known limitations](#known-limitations) · [Credits and licence](#credits-and-licence)

## Architecture

```mermaid
flowchart LR
  subgraph Clients
    B[Browser: dashboard and client portal]
    W[Widget on an agency's site]
    M[MCP client]
    X[API integrator]
  end
  subgraph Vercel["Vercel Hobby (functions)"]
    WEB[web: Next.js 16<br/>server actions, portal, auth]
    API[api: Express 5<br/>/v1 REST, webhooks, OpenAPI,<br/>/jobs/run/:type]
    AI[ai: FastAPI<br/>RAG, quote agent, MCP]
  end
  PG[(Neon Postgres 17<br/>public: Prisma<br/>ai: Alembic + pgvector)]
  Q[Upstash QStash<br/>immediate jobs + schedules]
  S3[(Supabase Storage<br/>PDFs, encrypted backups)]
  LLM[NVIDIA NIM<br/>Groq fallback]
  PAY[Stripe / Razorpay]
  B --> WEB
  W --> API
  X --> API
  M --> AI
  WEB -->|packages/core| PG
  WEB -->|/api/v1 rewrite| API
  WEB -->|chat proxy, service JWT| AI
  API -->|packages/core| PG
  API -->|outbox push| Q
  Q -->|signed POST| API
  API --> S3
  API -->|index jobs| AI
  AI -->|read-only role| PG
  AI -->|/internal, service JWT| API
  AI --> LLM
  PAY -->|webhooks| API
  API -->|signed outbound webhooks| X
```

Why it is split this way:

- **Business logic lives in `packages/core`**, used by the Next.js server
  actions, the Express API and the job processors alike, so a rule (GST,
  numbering, payment state) exists once.
- **The Express API is the public contract** (`/v1`, OpenAPI 3, scoped API
  keys, idempotency keys, rate limits). The old Next `/api/v1` routes now
  rewrite to it ([ADR 0007](docs/adr/0007-api-v1-parity-port.md)).
- **Every side effect goes through a transactional outbox**, then a job
  ([ADR 0003](docs/adr/0003-transactional-outbox.md)): the same processors run
  under BullMQ locally and from QStash on Vercel
  ([ADR 0002](docs/adr/0002-qstash-schedules.md)).
- **The AI service is Python**, owns only the `ai` schema, reads `public`
  through a read-only role, and writes only through the API.
- **The hosted demo costs $0 and cannot be billed**: card-free free tiers only
  ([ADR 0001](docs/adr/0001-free-stack-instead-of-aws.md)).

## Features

| Area                | What is there                                                                                                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRM                 | Leads (import with de-duplication, bulk actions), deals on a drag-and-drop Kanban (keyboard accessible, optimistic moves), deal → quote                                                                                             |
| Quotes and invoices | Block-based quote builder with undo/redo (Redux Toolkit), e-signature on the client portal, quote → invoice, recurring invoices, reminders, credit notes, PDFs                                                                      |
| GST (India)         | CGST/SGST/IGST by place of supply, HSN/SAC, Rule 46 checks before an invoice is issued, financial-year numbering (`INV/26-27/0001`)                                                                                                 |
| Payments            | Stripe Connect and Razorpay behind one provider interface; signature-verified, de-duplicated webhooks are the only source of payment state                                                                                          |
| API and webhooks    | `/v1` REST with OpenAPI ([`apps/api/openapi.json`](apps/api/openapi.json), Scalar UI at `/docs`), scoped secret keys, origin-scoped publishable keys, `Idempotency-Key`, per-key rate limits, signed outbound webhooks with retries |
| Jobs                | Transactional outbox; email, PDF render, webhook delivery, AI indexing, recurring invoices, reminders, automations, nightly reports and backups                                                                                     |
| Automations         | A small rule builder (trigger → wait → approval → action) with in-app approvals                                                                                                                                                     |
| AI assistant        | Chat with citations over invoices, quotes, contracts and notes (pgvector), SQL tools for numbers, a quote-drafting agent whose output is validated against the workspace before anything is saved, per-workspace daily budgets      |
| MCP                 | 10 tools and 2 resources over stateless HTTP or stdio, authenticated by workspace API keys                                                                                                                                          |
| Widget              | Embeddable lead form, quote link and invoice payment (Preact, Shadow DOM, 10.8 kB gzip, SRI hash per build)                                                                                                                         |
| Dashboard           | Revenue, receivables ageing, GST summary, pipeline; mixed currencies are converted to the workspace's base currency and labelled                                                                                                    |

## Tech stack

| Layer        | Choice                                                                        |
| ------------ | ----------------------------------------------------------------------------- |
| Web          | Next.js 16, React 19, Tailwind 4, Redux Toolkit (quote builder), Auth.js 5    |
| API and jobs | Express 5, Zod 4, BullMQ 6 / Upstash QStash, OpenAPI via zod-to-openapi       |
| Data         | Postgres 17 + pgvector 0.8, Prisma 7.10, Alembic (AI schema)                  |
| AI           | Python 3.12, FastAPI, SQLAlchemy 2 (asyncpg), LangChain, MCP SDK, pandas      |
| Payments     | Stripe (API 2026-08-26), Razorpay Orders                                      |
| Tests        | Vitest 5, Testcontainers, Playwright 1.63, axe-core, pytest, Schemathesis, k6 |
| Ops          | Vercel, Neon, Supabase Storage, Upstash, Redis Cloud, Sentry, UptimeRobot     |

TypeScript is pinned at 5.9.3, Node at 24 (`.nvmrc`), pnpm at 9.15.0.

## How it's built

The work went in phases, each built test-first, reviewed by the other developer,
fixed, and closed with a document that records what was run and what was seen.

| Phase | What                                                                          | Evidence                                               |
| ----- | ----------------------------------------------------------------------------- | ------------------------------------------------------ |
| 1     | Upgrades: Next 16, Prisma 7, Tailwind 4, Zod 4, Stripe API 2026, Postgres 17  | [phase-1](docs/phase-1.md)                             |
| 2     | `packages/core`, the Express API, the outbox and jobs                         | [phase-2](docs/phase-2.md)                             |
| 3     | CRM, GST engine, Razorpay, demo seed                                          | [phase-3](docs/phase-3.md)                             |
| 4     | Redux Toolkit builder, widget, automations, CSP                               | [phase-4](docs/phase-4.md)                             |
| 5     | AI service: RAG, agent, MCP, budgets, evals                                   | [phase-5](docs/phase-5.md)                             |
| 6     | Operations: backups, restore and rollback drills, alerts, runbook             | [phase-6](docs/phase-6.md), [runbook](docs/runbook.md) |
| 6b    | `/api/v1` ported to the Express API behind a parity test                      | [phase-6b](docs/phase-6b.md)                           |
| 7     | Polish: this README, ADRs, measurements, cross-browser and accessibility pass | [phase-7](docs/phase-7.md)                             |

Decisions worth reading first:

| ADR                                                | Decision                                                |
| -------------------------------------------------- | ------------------------------------------------------- |
| [0001](docs/adr/0001-free-stack-instead-of-aws.md) | The demo runs on card-free free tiers, not AWS          |
| [0002](docs/adr/0002-qstash-schedules.md)          | Scheduled jobs are QStash schedules                     |
| [0003](docs/adr/0003-transactional-outbox.md)      | A transactional outbox for every side effect            |
| [0004](docs/adr/0004-tenant-guard.md)              | A Prisma tenant guard on every workspace-owned model    |
| [0005](docs/adr/0005-nim-and-groq.md)              | NVIDIA NIM for chat and embeddings, Groq as fallback    |
| [0006](docs/adr/0006-pgvector-halfvec.md)          | Embeddings as pgvector `halfvec(2048)`                  |
| [0007](docs/adr/0007-api-v1-parity-port.md)        | `/api/v1` ported behind a recorded-response parity test |
| [0008](docs/adr/0008-encrypted-logical-backups.md) | Nightly logical backups, encrypted                      |

## Measured

### AI evals

84 items (40 RAG questions, 20 SQL questions, 14 quote briefs, 10
isolation/jailbreak prompts) on the demo data.

| Metric                  | Live run, NVIDIA NIM (2026-08-23)      | Offline model (CI) | Threshold |
| ----------------------- | -------------------------------------- | ------------------ | --------- |
| Retrieval recall@6      | 1.0                                    | 1.0                | ≥ 0.85    |
| Citation precision      | 1.0                                    | 0.9                |           |
| Answer correctness, RAG | 0.9                                    | 0.125              |           |
| Answer correctness, SQL | 0.75 (re-scored)                       | 1.0                |           |
| Schema-valid drafts     | 1.0 (5 finished drafts)                | 1.0                | = 1.0     |
| Cross-tenant leaks      | 0 (re-scored; 1 false positive before) | 0                  | = 0       |
| p95 latency             | 64.5 s                                 | 118 ms             |           |

Read these with their caveats ([phase-5](docs/phase-5.md), "Live eval run"):
the live run was made from a laptop in India against a database in us-east-1,
and 9 of 14 quote drafts plus 2 isolation prompts hit the agent's 60 s wall
clock, so draft quality under production latency is not measured. The SQL
figure is a re-score of the same stored answers after the scorer was fixed to
compare values instead of tokens. The offline model's scores test the pipeline
around the model, not a model: its schema-valid 1.0 is true by construction.

### Web vitals (field data from the live demo)

**Source: scripted browsing, not users.** The demo is behind Vercel
authentication and has no real users. A Playwright script (Chromium, desktop
1440 px and an emulated Pixel 7, signed in as the demo user, 8 dashboard
pages × 4 rounds, one click and one Tab per page) browsed the deployment of
2026-08-30 from one machine in India; the app's own `/api/vitals` endpoint
logged the beacons on Vercel, summarised at p75 with
`apps/web/lib/observability/web-vitals.ts`. Small samples: one fast machine
on one network.

| Metric | p75    | Rating | Samples |
| ------ | ------ | ------ | ------- |
| LCP    | 856 ms | good   | 27      |
| INP    | 8 ms   | good   | 16      |
| CLS    | 0.001  | good   | 21      |
| FCP    | 856 ms | good   | 27      |
| FID    | 4 ms   | good   | 21      |

- **LCP equals FCP** because, on most loads, the largest element is painted in
  the first contentful paint (server-rendered pages without a hero image): in
  the raw beacons, 24 of the 29 LCP values exactly equal an FCP value (23 of
  29 in the earlier run below). The two p75s coincide; they are not one
  metric reported twice.
- **TTFB is left out:** most samples (about 40 ms) are below the network round
  trip to the us-east-1 servers, so it does not measure the server here (why
  was not investigated).
- Counts differ per metric because a beacon is lost when the script navigates
  away before it is sent.
- A run on the previous deployment the same morning (196 samples) gave LCP
  1,556 ms, INP 48 ms, CLS 0.001 at p75 ([phase-7](docs/phase-7.md)); the
  difference was not analysed.

### Lighthouse (live demo, Lighthouse 12, this release)

| Page       | Form factor | Performance | Accessibility | Best practices | LCP   | TBT    | CLS   |
| ---------- | ----------- | ----------- | ------------- | -------------- | ----- | ------ | ----- |
| /login     | mobile      | 81          | 100           | 96             | 3.9 s | 282 ms | 0     |
| /dashboard | mobile      | 69          | 95            | 96             | 4.3 s | 484 ms | 0.001 |
| /invoices  | mobile      | 75          | 96            | 96             | 4.5 s | 286 ms | 0.001 |
| /deals     | mobile      | 72          | 95            | 96             | 5.3 s | 276 ms | 0.001 |
| /login     | desktop     | 98          | 100           | 96             | 1.1 s | 21 ms  | 0     |
| /dashboard | desktop     | 88          | 96            | 96             | 1.2 s | 36 ms  | 0.001 |
| /invoices  | desktop     | 94          | 96            | 96             | 1.4 s | 20 ms  | 0.001 |
| /deals     | desktop     | 96          | 96            | 96             | 1.0 s | 14 ms  | 0.001 |

One run per page from an M1 laptop on a home connection; Lighthouse scores
move by several points between runs (an earlier run, made while E2E suites
were using the same CPU, scored mobile 43-53 and is not used). Lighthouse's
mobile profile (4× CPU slowdown, slow 4G) puts LCP at 3.9-5.3 s: the
dashboard's JavaScript is the main open front-end performance problem. The
accessibility points lost are the header's "Beta" badge contrast. SEO is not
shown: the demo is deliberately not indexable.

### Operations drills (live demo)

| Drill                                                          | Result                                                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Restore the latest encrypted backup into a scratch Neon branch | 61 tables, 1,376 rows, 0 mismatches, 80.8 s                                                 |
| Point-in-time restore (Neon branch at a past timestamp)        | branch 3.9 s, first query 2.9 s                                                             |
| Deliberately broken deploy                                     | smoke test failed on `/readyz` 500, automatic rollback in 5.8 s; production broken for 24 s |
| Alert delivery                                                 | UptimeRobot and Sentry alerts reached the owner's inbox                                     |

### Load test (local only)

k6 1.3.0 against the Express API in production mode on one laptop (Apple M1,
8 GB; API, Postgres, Redis and k6 on the same machine), with rate limits and
idempotency in **Redis** as in production. Three read endpoints (40% client
list, 40% invoice list, 20% one invoice) on a small dataset. Offered load
(ramping arrival rate, 6 minutes): starts at 10/s, ramps to 50/s over 30 s,
holds 60 s, then the same ramp-and-hold to 100, 200 and 400 requests/s. One
API key, rate limit 100,000/min (the per-key limiter never applies).

Two runs at the same commit, minutes apart:

| Run | Requests | p50     | p95      | p99      | Failed           | Dropped | Thresholds                        |
| --- | -------- | ------- | -------- | -------- | ---------------- | ------- | --------------------------------- |
| A   | 61,505   | 6.44 ms | 101.3 ms | 265.6 ms | 714 (1.16%), 429 | 144     | **fail** (`http_req_failed` ≥ 1%) |
| B   | 61,630   | 6.09 ms | 19.2 ms  | 61.2 ms  | 12 (0.01%), 429  | 19      | pass                              |

Thresholds: `http_req_failed` rate < 1% and p95 of the client list < 500 ms
(A: 84 ms, B: 17 ms). Every failure was a 429. In run B the script recorded
which limiter answered each one (a per-key 429 carries `RateLimit-Policy`, a
failed-auth 429 does not): all 12 came from the **failed-authentication
limiter**, in one second at 400/s during a latency spike (max 878 ms). That
limiter reserves a slot per request until the key check passes, so more than
30 requests from one address whose key checks overlap get 429 (see
[phase-7](docs/phase-7.md)). Run A predates that instrumentation, so its 714
are attributed only by inference; a few short unit-test runs shared the CPU
during its first two minutes. The spread between A and B is itself a result:
two runs are not enough to give one number. The p50 includes the 429s, which
answer fast, so it is slightly optimistic.

This says the read path is not slow on a small dataset; it says nothing about
capacity in production, and no scale claim is made. Run it with
`DATABASE_URL=… LOADTEST_REDIS_URL=redis://… apps/api/scripts/loadtest.sh`.

## Quick start

Needs Node 24, Docker, and pnpm 9.15 (`corepack enable` picks it up from
`package.json`, or prefix every `pnpm` with `npx -y pnpm@9.15.0`).

```bash
git clone <this repository> app && cd app
pnpm install
docker compose up -d postgres redis mailpit

cp .env.example .env
cp apps/web/.env.example apps/web/.env.local
# Auth.js needs a secret in apps/web/.env.local:
sed -i.bak "s|^NEXTAUTH_SECRET=.*|NEXTAUTH_SECRET=$(openssl rand -base64 32)|" apps/web/.env.local

pnpm db:generate
pnpm db:migrate:deploy
pnpm db:seed                                   # demo@wolff.demo / DemoPassword123!
pnpm --filter @wolff/database seed:demo        # optional: the GST and CRM demo workspaces

pnpm --filter @wolff/web dev                   # http://localhost:3000
```

Sign in with `demo@wolff.demo` / `DemoPassword123!`. Email goes to Mailpit
(http://localhost:8025). The API (`pnpm --filter @wolff/api dev`, port 4000,
docs at `/docs`) and the AI service (`docker compose up -d ai`, offline model by
default) are optional for the dashboard.

Measured once, cold, on an Apple M1 Mac (not a Codespace): these exact steps
from `git clone` to a signed-in dashboard took 133 s with an empty pnpm store
and cache (install 83 s, 1.5 GB). The three images were cached for that run;
pulled cold in an empty Docker daemon they took another 79 s (763 MB
unpacked). About 3.5 minutes in all, on a fast connection.

## Tests and CI

| Suite                                               | Tests                           | Line coverage                                                                         |
| --------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------- |
| `apps/web` (Vitest)                                 | 1,264                           | 15.4% (every file under app, components, lib, hooks; the UI is mostly covered by E2E) |
| `apps/api` (Vitest, Postgres, Testcontainers)       | 465                             | 90.5%                                                                                 |
| `packages/core`                                     | 360                             | 93.4%                                                                                 |
| `packages/jobs` (real Redis and S3 containers)      | 117 + 1 skipped                 | 92.8%                                                                                 |
| `packages/database`                                 | 42                              | 88.9%                                                                                 |
| `packages/contracts`                                | 18                              | 13.9% (its schemas are exercised by the api tests, which do not count here)           |
| `apps/widget`                                       | 12                              | 86.3%                                                                                 |
| `services/ai` (pytest)                              | 234 + 1 skipped                 | 94% statements                                                                        |
| E2E (Playwright: flows, product, widget, assistant) | 51                              | Chromium, Firefox and WebKit                                                          |
| Visual regression                                   | 10 pages × 3 widths (30 images) | darwin and linux baselines                                                            |

Coverage counts every source file, not just the ones a test imports. There are
no coverage badges yet: badge services need the public repository and a CI run.
Commands:

```bash
TEST_DATABASE_URL=postgresql://wolff:wolff_dev_only@localhost:5432/wolff_test \
STRIPE_MOCK_URL=http://localhost:12111 pnpm test       # unit and integration
pnpm test:coverage -- --concurrency=1                   # same, with coverage
(cd services/ai && uv run pytest --cov=app)             # AI service
E2E_BROWSER=firefox pnpm --filter @wolff/web exec playwright test -c playwright.flows.config.ts
```

Other checks: Schemathesis over all 51 OpenAPI operations, the `/api/v1`
parity suite (112 recorded responses), the AI isolation suite (`pytest -m
isolation`, 0 leaks), axe (no serious or critical violations on the main
pages), and a check that none of 8 dashboard pages (dashboard, quotes,
invoices, clients, leads, deals, automations, settings) scrolls sideways, as a
page or inside its content area, at 320, 375, 768, 1024, 1440 and 1920 px.

CI is defined in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) (lint,
type-check, unit, migrations, AI, Schemathesis, build, E2E and visual). It has
not run on GitHub yet, because the repository has not been published; every
job was reproduced locally.

## Known limitations

- **Mobile performance.** Lighthouse mobile LCP is 3.9-5.3 s; the dashboard
  ships too much JavaScript for a slow phone.
- **AI latency.** Free LLM endpoints are slow; quote drafts can exceed the
  60 s limit, and the Groq fallback has about 10 s of headroom.
- **GST rules are unreviewed.** The golden vectors were worked by hand from
  the rules; no chartered accountant has checked them.
- **Payments on mocks and test mode only.** Stripe and Razorpay ran in test
  mode; no real money has moved.
- **Free tiers.** QStash's 1,000 messages a day cap demo activity; the backup
  export must finish within 200 s; Neon keeps 6 hours of history.
- **Failed-auth limiter and parallel clients.** More than 30 requests in
  flight at once from one address get 429 (the cost of counting guesses
  safely).
- **Accessibility.** Moderate axe findings remain (heading order on some
  pages); the client portal shows amounts in the workspace's own brand
  colour, whose contrast the workspace chooses.
- **No OAuth on MCP**; API keys only.

## Credits and licence

Based on [orekoapp/oreko](https://github.com/orekoapp/oreko), whose copyright notices are kept.
Licensed under the [GNU AGPL v3](LICENSE): if you run a modified version as a
network service, you must offer its source to its users.
