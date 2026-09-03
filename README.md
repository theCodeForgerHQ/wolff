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

p75 of the samples the app's own `/api/vitals` endpoint logged on Vercel,
summarised with `apps/web/lib/observability/web-vitals.ts`:

| Metric | p75     | Rating | Samples |
| ------ | ------- | ------ | ------- |
| LCP    | 1556 ms | good   | 28      |
| INP    | 48 ms   | good   | 25      |
| CLS    | 0.001   | good   | 41      |
| FCP    | 1244 ms | good   | 39      |
| TTFB   | 71 ms   | good   | 35      |
| FID    | 7 ms    | good   | 28      |

Caveat: the demo is behind Vercel authentication and has no real users. These
samples come from scripted browsing (Playwright Chromium, desktop 1440 px and
an emulated Pixel 7, signed in as the demo user, 8 dashboard pages × 4 rounds
each) from one machine in India on 2026-08-30. Most TTFB samples (about 40 ms)
are below the network round trip to the us-east-1 servers, so that row does not
measure the server; the reason was not investigated.

### Lighthouse (live demo, Lighthouse 12)

| Page       | Form factor | Performance | Accessibility | Best practices | LCP   | TBT      | CLS   |
| ---------- | ----------- | ----------- | ------------- | -------------- | ----- | -------- | ----- |
| /login     | mobile      | 53          | 100           | 96             | 5.7 s | 591 ms   | 0     |
| /dashboard | mobile      | 43          | 90            | 96             | 7.5 s | 925 ms   | 0.001 |
| /invoices  | mobile      | 47          | 91            | 96             | 5.8 s | 1,299 ms | 0.043 |
| /deals     | mobile      | 45          | 90            | 96             | 5.4 s | 3,272 ms | 0.001 |
| /login     | desktop     | 79          | 100           | 96             | 2.1 s | 46 ms    | 0     |
| /dashboard | desktop     | 91          | 90            | 96             | 1.5 s | 140 ms   | 0.001 |
| /invoices  | desktop     | 96          | 91            | 96             | 1.0 s | 18 ms    | 0.001 |
| /deals     | desktop     | 92          | 96            | 96             | 1.4 s | 8 ms     | 0     |

Lighthouse's mobile profile (4× CPU slowdown, slow 4G) shows the dashboard's
JavaScript cost: performance in the 40s and LCP over 5 s. That is the main open
front-end performance problem. SEO scores are not shown: the demo is
deliberately not indexable (protected deployment, no robots.txt).

### Operations drills (live demo)

| Drill                                                          | Result                                                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Restore the latest encrypted backup into a scratch Neon branch | 61 tables, 1,376 rows, 0 mismatches, 80.8 s                                                 |
| Point-in-time restore (Neon branch at a past timestamp)        | branch 3.9 s, first query 2.9 s                                                             |
| Deliberately broken deploy                                     | smoke test failed on `/readyz` 500, automatic rollback in 5.8 s; production broken for 24 s |
| Alert delivery                                                 | UptimeRobot and Sentry alerts reached the owner's inbox                                     |

### Load test (local only)

k6 against the Express API on one laptop (Apple M1, 8 GB; API, Postgres and
k6 on the same machine), three read endpoints, offered load stepping 50 → 100
→ 200 → 400 requests/s: 61,600 requests, p50 3.9 ms, p95 14.2 ms, p99 173 ms.
932 requests (1.5%) got 429 from the failed-authentication limiter, which
counts requests in flight (see [phase-7](docs/phase-7.md)). This says the
code path is not slow on a small dataset; it says nothing about capacity in
production, and no scale claim is made. Run it with
`DATABASE_URL=… apps/api/scripts/loadtest.sh`.

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

## Tests and CI

| Suite                                               | Tests              | Line coverage                                                                         |
| --------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------- |
| `apps/web` (Vitest)                                 | 1,255              | 15.3% (every file under app, components, lib, hooks; the UI is mostly covered by E2E) |
| `apps/api` (Vitest, Postgres, Testcontainers)       | 451                | 90.4%                                                                                 |
| `packages/core`                                     | 288                | 76.0%                                                                                 |
| `packages/jobs` (real Redis and S3 containers)      | 117 + 1 skipped    | 92.8%                                                                                 |
| `packages/database`                                 | 42                 | 88.9%                                                                                 |
| `packages/contracts`                                | 18                 | 13.9% (its schemas are exercised by the api tests, which do not count here)           |
| `apps/widget`                                       | 12                 | 86.3%                                                                                 |
| `services/ai` (pytest)                              | 234 + 1 skipped    | 94% statements                                                                        |
| E2E (Playwright: flows, product, widget, assistant) | 50                 | Chromium, Firefox and WebKit                                                          |
| Visual regression                                   | 7 pages × 3 widths | darwin and linux baselines                                                            |

Coverage counts every source file, not just the ones a test imports. Commands:

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
pages), and a check that no dashboard page scrolls sideways from 320 to
1920 px.

CI is defined in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) (lint,
type-check, unit, migrations, AI, Schemathesis, build, E2E and visual). It has
not run on GitHub yet, because the repository has not been published; every
job was reproduced locally.

## Known limitations

- **Mobile performance.** Lighthouse mobile scores are 43-53; the dashboard
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
