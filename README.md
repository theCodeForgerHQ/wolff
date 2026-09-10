# Quote-to-cash for agencies and freelancers

![Next.js](https://img.shields.io/badge/web-Next.js_16_·_React_19-15212e)
![Express](https://img.shields.io/badge/api-Express_5_·_OpenAPI_3-3b6ea5)
![FastAPI](https://img.shields.io/badge/ai-FastAPI_·_Python_3.12-2f8f4e)
![Postgres](https://img.shields.io/badge/data-Postgres_17_·_pgvector-336791)
![Tests](https://img.shields.io/badge/tests-2,800%2B_passing-2e7d32)
![Cost](https://img.shields.io/badge/hosting-%240_free_tiers-607d8b)
![Licence](https://img.shields.io/badge/licence-AGPL--3.0-c0562f)

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

**Live:**

| What                            | Where                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| Dashboard and client portal     | https://wolff-web.vercel.app, click **Try Demo** (no sign-up; the data resets daily) |
| REST API reference (Scalar)     | https://wolff-api.vercel.app/docs                                                    |
| REST API reference (Swagger UI) | https://wolff-api.vercel.app/swagger                                                 |
| OpenAPI 3 document              | https://wolff-api.vercel.app/openapi.json                                            |
| API health                      | https://wolff-api.vercel.app/healthz and `/readyz`                                   |

![Dashboard](docs/images/screenshots/dashboard.png)

## Contents

1. [Screenshots](#screenshots)
2. [Architecture](#architecture)
3. [A payment, end to end](#a-payment-end-to-end)
   - [Data model](#data-model) · [Document lifecycle](#document-lifecycle) · [Background jobs](#background-jobs) · [AI assistant](#ai-assistant)
4. [Features](#features)
5. [Tech stack](#tech-stack)
6. [Project structure](#project-structure)
7. [API reference](#api-reference)
8. [How it's built](#how-its-built)
9. [Measured](#measured)
10. [Quick start](#quick-start)
11. [Tests and CI](#tests-and-ci)
12. [Deployment](#deployment)
13. [Security](#security)
14. [Known limitations](#known-limitations)
15. [Credits and licence](#credits-and-licence)

## Screenshots

| Quotes                                        | Invoices                                          |
| --------------------------------------------- | ------------------------------------------------- |
| ![Quotes](docs/images/screenshots/quotes.png) | ![Invoices](docs/images/screenshots/invoices.png) |

| API reference (Swagger UI)                             | Quote builder                                   |
| ------------------------------------------------------ | ----------------------------------------------- |
| ![Swagger UI](docs/images/screenshots/api-swagger.png) | ![Quote builder](docs/images/quote-builder.png) |

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

## A payment, end to end

What happens between a client clicking Pay and the receipt landing in their inbox.

```mermaid
sequenceDiagram
  autonumber
  actor C as Client
  participant P as Portal (web)
  participant S as Stripe / Razorpay
  participant A as API
  participant DB as Postgres
  participant Q as QStash
  participant E as Email (Resend)
  C->>P: Opens the invoice link, clicks Pay
  P->>S: Creates a checkout session
  C->>S: Pays
  S->>A: Signed webhook (raw body checked)
  A->>DB: Stores the provider event once (idempotent)
  A->>DB: Outbox row: reconcile payment
  A->>Q: Relays the job
  Q->>A: Signed POST /jobs/run/reconcile-payment
  A->>DB: Records the payment, marks the invoice paid, adds outbox rows
  A->>Q: Relays the receipt and webhook jobs right away
  Q->>A: send-email, deliver-webhook
  A->>E: Receipt to the client
  A-->>C: Signed outbound webhook to the agency's endpoint
  Note over A,DB: An hourly sweep re-relays anything a crash left behind
```

## Data model

The core tables, out of 55. Every row belongs to one workspace, and every
query is scoped to it.

```mermaid
erDiagram
  WORKSPACE ||--o{ CLIENT : has
  WORKSPACE ||--o{ LEAD : has
  WORKSPACE ||--o{ PIPELINE : has
  WORKSPACE ||--o{ API_KEY : issues
  WORKSPACE ||--o{ WEBHOOK_ENDPOINT : registers
  WORKSPACE ||--o{ OUTBOX_EVENT : queues
  PIPELINE ||--o{ STAGE : orders
  STAGE ||--o{ DEAL : holds
  LEAD |o--o| DEAL : "converts to"
  DEAL |o--o| QUOTE : "priced by"
  CLIENT ||--o{ QUOTE : receives
  CLIENT ||--o{ INVOICE : receives
  CLIENT ||--o{ CONTRACT : signs
  QUOTE ||--|{ QUOTE_LINE_ITEM : lists
  QUOTE |o--o| INVOICE : "converts to (one)"
  INVOICE ||--|{ INVOICE_LINE_ITEM : lists
  INVOICE ||--o{ PAYMENT : "paid by"
```

## Document lifecycle

```mermaid
stateDiagram-v2
  direction LR
  state Quote {
    [*] --> draft
    draft --> sent: send email
    sent --> viewed: client opens the link
    viewed --> accepted: e-signature with a one-time code
    viewed --> declined
    sent --> expired: past its expiry date
    viewed --> expired
    accepted --> converted: invoice created
  }
  state Invoice {
    [*] --> i_draft
    i_draft --> i_sent: issued (GST invoices only after the Rule 46 check)
    i_sent --> i_viewed
    i_viewed --> partial: part payment
    i_sent --> overdue: nightly job
    i_viewed --> overdue
    partial --> paid
    i_viewed --> paid
    overdue --> paid
    i_sent --> voided
  }
  converted --> i_draft
```

`i_` marks the invoice's states where the names repeat.

## Background jobs

Nothing slow or external runs inside a request. The request writes an outbox
row in the same transaction as its change, so a job is never lost and never
sent for a change that rolled back.

```mermaid
flowchart LR
  R[Request or webhook] -->|same transaction| T[(Change + outbox row)]
  T --> RL[Relay]
  RL -->|on Vercel| QS[QStash]
  RL -->|locally| BQ[BullMQ on Redis]
  QS -->|signed POST /jobs/run/:type| P[Job processor]
  BQ --> P
  P -->|success| D[outbox: done]
  P -->|error| RT{Attempts left?}
  RT -->|yes, exponential backoff| P
  RT -->|no| F[outbox: failed, error reported]
  P -->|follow-up rows, relayed at once| RL
  CR[Schedules: hourly tick, nightly reports,<br/>daily AI sweep, weekly backup] --> QS
  SW[Hourly sweep] -->|re-relays rows a crash left pending| RL
```

Jobs: PDF rendering, emails, payment reconciliation, outbound webhooks,
recurring invoices, overdue marking, reminders, automations, AI indexing and
encrypted backups.

## AI assistant

```mermaid
flowchart TB
  U[Question in the dashboard] --> W[web: chat proxy, service JWT]
  W --> G{Daily budget gate<br/>per workspace}
  G -->|over budget| X[Polite refusal]
  G --> A[Tool-calling agent]
  A -->|numbers| SQL[SQL tools, read-only role:<br/>overdue invoices, ageing, top debtors,<br/>GST summary, leads, deals]
  A -->|wording, terms, history| S[search_documents]
  S --> V[(pgvector halfvec, HNSW<br/>workspace filter inside the SQL)]
  V -->|20 nearest| RR[Re-rank: cosine + full-text + recency]
  RR -->|best 6, similarity >= 0.15| A
  A --> L[NVIDIA NIM, Groq fallback<br/>when a provider fails or is gone]
  L --> ANS[Plain-text answer streamed back,<br/>with sources]
  subgraph Indexing
    J[ai.index job] --> LD[Load document] --> SP[Split 800/100] --> H{Changed?}
    H -->|no| SK[Skip]
    H -->|yes| EM[Embed] --> V
  end
```

The same agent drafts quotes from a short brief, and an MCP server exposes
these tools to any MCP client, using scoped API keys.

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

## Project structure

```text
.
├── apps
│   ├── web          Next.js 16: dashboard, client portal, auth, server actions
│   ├── api          Express 5: /v1 REST, webhooks in and out, OpenAPI, /jobs/run/:type
│   └── widget       embeddable quote request widget
├── packages
│   ├── core         domain logic shared by web, api and jobs (quotes, invoices, GST, CRM, automations)
│   ├── database     Prisma 7 schema, migrations and seeds (owns the public schema)
│   ├── jobs         job processors: outbox relay, email, PDFs, payments, webhooks, backups, AI indexing
│   ├── contracts    Zod schemas shared by the API and its OpenAPI document
│   └── types, ui, utils
├── services
│   └── ai           FastAPI: RAG over pgvector, quote agent, MCP server, evals (Alembic owns the ai schema)
├── infra            database bootstrap SQL and roles
├── scripts          deploy.sh (git archive, deploy, smoke test, automatic rollback)
├── docs             phase write-ups, ADRs 0001-0008, runbook, free-tier notes
└── tests            manual regression test cases
```

## API reference

The public API is described by one OpenAPI 3 document, generated from the
same Zod schemas the routes validate with, so the docs cannot drift from the
code.

- **Swagger UI:** [`/swagger`](https://wolff-api.vercel.app/swagger), try
  requests straight from the browser with an API key.
- **Scalar:** [`/docs`](https://wolff-api.vercel.app/docs), the same document
  with code samples.
- **Raw document:** [`/openapi.json`](https://wolff-api.vercel.app/openapi.json),
  for client generators and Postman.

Every `/v1` route takes a workspace API key (`Authorization: Bearer ...`) with
scopes, honours `Idempotency-Key` on writes, and returns errors in one envelope.
Covered: clients, quotes, invoices, payment links, leads, pipelines, deals,
reports (revenue, ageing, GST summary, pipeline), and webhook endpoints with
delivery history and retries. Locally the API runs on port 4000 with the same
three pages.

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

### Web vitals (live demo, 2026-09-10)

**Source: scripted browsing, not users.** A Playwright script (Chromium,
desktop 1440 px and an emulated Pixel 7 without CPU throttling, signed in as
the demo user) opened 8 dashboard pages (dashboard, quotes, invoices,
clients, leads, deals, automations, settings) 3 times each, with one click
and one Tab per page, from one machine in India against the us-east-1
deployment. Values were read in the page with `PerformanceObserver` and
summarised at p75. Small samples: one fast machine on one network.

| Metric | Desktop p75 | Mobile p75 | Rating | Samples |
| ------ | ----------- | ---------- | ------ | ------- |
| LCP    | 772 ms      | 600 ms     | good   | 24 + 24 |
| INP    | 16 ms       | 16 ms      | good   | 24 + 24 |
| CLS    | 0.001       | 0          | good   | 24 + 24 |
| FCP    | 772 ms      | 600 ms     | good   | 24 + 24 |

- **LCP equals FCP** because the pages are server-rendered without a hero
  image: the largest element is painted in the first contentful paint.
- **INP of 16 ms** is the observer's floor: no interaction took longer.
- **Mobile is faster than desktop here** only because the emulated phone has
  a smaller viewport and the same laptop CPU; Lighthouse below throttles the
  CPU and gives the realistic mobile picture.
- The earlier release measured LCP 856 ms and INP 8 ms the same way, through
  the app's own `/api/vitals` beacons ([phase-7](docs/phase-7.md)).

### Lighthouse (live demo, Lighthouse 12, 2026-09-10)

| Page       | Form factor | Performance | Accessibility | Best practices | LCP   | TBT    | CLS   |
| ---------- | ----------- | ----------- | ------------- | -------------- | ----- | ------ | ----- |
| /login     | mobile      | 72          | 100           | 96             | 5.1 s | 160 ms | 0     |
| /dashboard | mobile      | 66          | 95            | 100            | 6.2 s | 230 ms | 0     |
| /invoices  | mobile      | 64          | 96            | 100            | 5.9 s | 350 ms | 0     |
| /deals     | mobile      | 67          | 95            | 100            | 5.5 s | 300 ms | 0.001 |
| /login     | desktop     | 96          | 100           | 96             | 1.2 s | 10 ms  | 0     |
| /dashboard | desktop     | 90          | 96            | 100            | 1.5 s | 0 ms   | 0.001 |
| /invoices  | desktop     | 94          | 96            | 100            | 1.4 s | 10 ms  | 0.001 |
| /deals     | desktop     | 96          | 96            | 100            | 1.2 s | 0 ms   | 0.001 |

One run per page from an M1 laptop on a home connection, with nothing else
running; Lighthouse scores move by several points between runs. Lighthouse's
mobile profile (4× CPU slowdown, slow 4G) puts LCP at 5.1-6.2 s, up from
3.9-5.3 s in the previous release's single run: the dashboard's JavaScript is
the main open front-end performance problem. The accessibility points lost
are the header's "Beta" badge contrast. SEO is not shown: the demo is
deliberately not indexable.

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
| `apps/web` (Vitest)                                 | 1,381 + 7 skipped               | 19.8% (every file under app, components, lib, hooks; the UI is mostly covered by E2E) |
| `apps/api` (Vitest, Postgres, Testcontainers)       | 499                             | 90.5%                                                                                 |
| `packages/core`                                     | 406                             | 93.4%                                                                                 |
| `packages/jobs` (real Redis and S3 containers)      | 142 + 4 skipped                 | 92.5%                                                                                 |
| `packages/database`                                 | 62                              | 89.4%                                                                                 |
| `packages/contracts`                                | 18                              | 13.9% (its schemas are exercised by the api tests, which do not count here)           |
| `apps/widget`                                       | 12                              | 86.3%                                                                                 |
| `services/ai` (pytest)                              | 256 + 1 skipped                 | 94% statements                                                                        |
| E2E (Playwright: flows, product, widget, assistant) | 51                              | Chromium, Firefox and WebKit                                                          |
| Visual regression                                   | 10 pages × 3 widths (30 images) | darwin and linux baselines                                                            |

Counts and coverage measured 2026-09-10. Coverage counts every source file,
not just the ones a test imports. There are
no coverage badges yet: badge services need the public repository and a CI run.
Commands:

```bash
TEST_DATABASE_URL=postgresql://wolff:wolff_dev_only@localhost:5432/wolff_test \
STRIPE_MOCK_URL=http://localhost:12111 pnpm test       # unit and integration
pnpm exec turbo run test:coverage --concurrency=1       # same, with coverage
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

## Deployment

Three Vercel projects (web, api, ai) on the Hobby plan, Neon Postgres, QStash
for jobs and schedules, Supabase Storage for PDFs and backups. Nothing has a
card on file, so nothing can be billed.

```bash
scripts/deploy.sh HEAD api        # or web, ai, or several
```

The script deploys from a clean `git archive` of the commit (never the working
tree), runs smoke tests against the new deployment, and only then moves the
production alias. If a smoke test fails it rolls back on its own; a
deliberately broken deploy was caught and reverted in 5.8 s. Environment
variables live in Vercel and in a secrets manager; none are in the
repository. Step-by-step operations, including restoring a backup, are in
[docs/runbook.md](docs/runbook.md).

## Security

- **Auth:** Auth.js sessions for the dashboard; scoped, hashed API keys for
  `/v1`; one-time codes before a client signs a quote; signed service JWTs
  between web, api and ai.
- **Tenancy:** every query is scoped to a workspace; the AI service reads
  through a read-only Postgres role and is tested for cross-workspace leaks
  (0 found).
- **Inbound webhooks:** Stripe and Razorpay signatures are checked over the raw
  body, and each event is processed once.
- **Outbound webhooks:** signed with a per-endpoint secret and retried with
  backoff.
- **Abuse:** rate limits on Redis with an in-memory fallback, a failed-auth
  limiter, a 1 s cap on waiting for Redis.
- **Headers:** a per-request nonce CSP on the web app, a strict CSP on the API
  (the two docs pages get a CDN exception), HSTS, `nosniff`, frame denial, and
  `no-referrer` on portal links.
- **Secrets:** none in git; errors are redacted before they are logged.

Report a vulnerability as described in [SECURITY.md](SECURITY.md).

## Known limitations

- **Mobile performance.** Lighthouse mobile LCP is 5.1-6.2 s; the dashboard
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
