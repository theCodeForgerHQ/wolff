# Phase 5: AI service

Branch `phase5-ai-service`, from `phase4-closed`. **Built, not yet
reviewed.** A separate reviewer has to go over
`phase4-closed..phase5-ai-service` before the phase can be closed. Nothing
is pushed and nothing is deployed.

There is no LLM key in this environment. Every LLM and embedding call in
the tests, the recorded eval run and the E2E runs goes to a deterministic
offline model (`LLM_PROVIDER=fake`, below). The Gemini and OpenAI clients
are built and unit-tested against recorded HTTP shapes only. **No live
provider call has been made.** The "one live run logged" criterion is
listed under "Needs the owner".

## What was built

| Task                                                                       | State                                              | Where                                                                                                                                                             |
| ------------------------------------------------------------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scaffold `services/ai` (uv, ruff, mypy), async SQLAlchemy (asyncpg)            | Done                                               | `services/ai/pyproject.toml`, `app/db/session.py`                                                                                                                 |
| Public models + contract test; Alembic `ai`                                    | Done                                               | `app/db/public_models.py`, `tests/test_schema_contract.py`, `alembic/`, `app/db/models.py`, Prisma migration `20260809150000_ai_schema`, `infra/db/bootstrap.sql` |
| Ingestion via outbox → `ai.index`; retriever; chat SSE                         | Done (partial write coverage, see Known issues)    | `app/rag/*`, `app/api/ingest.py`, `packages/jobs` (`ai.index`, `ai.sweep`), `apps/web/lib/{quotes,invoices}/actions.ts`, `app/agent/chat.py`, `app/api/chat.py`   |
| Quote agent with structured output, calling `/internal/*` with a forwarded JWT | Done                                               | `app/agent/quote_agent.py`, `app/agent/api_client.py`, `apps/api/src/routes/internal.ts`, `packages/core/src/quotes/draft.ts`                                     |
| `MCPServer` with an API-key `TokenVerifier` (OAuth stretch)                    | Done; OAuth not done                               | `app/mcp/*`                                                                                                                                                       |
| Budgets; eval dataset (extends the Phase 3 seed) + runner                      | Done                                               | `app/budget.py`, `app/llm/transport.py`, `packages/database/prisma/seed-demo-ai.ts`, `evals/`                                                                     |
| pandas nightly export + lead-score features                                    | Done (local files; the scorer itself is not built) | `app/reports/*`, `packages/jobs` (`reports.nightly`)                                                                                                              |
| Chat panel UI; Sentry/OTel in ai                                               | Done                                               | `apps/web/components/assistant/*`, `apps/web/app/api/assistant/*`, `app/observability.py`                                                                         |
| AI in CI and docker compose                                                    | Done (CI not yet run on GitHub)                    | `.github/workflows/ci.yml` (`ai` job, `migrations`, `e2e`), `docker-compose.yml`, `services/ai/Dockerfile`                                                        |

How the parts connect:

- **Roles.** `infra/db/bootstrap.sql` creates `ai_reader` (SELECT on
  `public`), `ai_owner` (owns the `ai` tables) and the login `ai_service`,
  which holds both. The Prisma migration creates the `vector` extension
  and the `ai` schema, with guarded grants. Alembic runs `SET ROLE ai_owner`.
- **Every query is scoped.** Workspace data is read through `scoped()`, or
  through a view filtered on `workspace_id`. The workspace comes only from
  the verified service JWT or API key, and no tool or endpoint accepts one
  from its arguments.
- **One LLM egress.** Both the OpenAI SDK (embeddings) and LangChain's
  `ChatOpenAI` (chat, tools, `json_schema` output) use one httpx2 client.
  It is built on `RateLimitedTransport`, which handles RPM/TPM token
  buckets, a requests-per-day counter (Redis when configured), bounded
  concurrency, two retries on 429/5xx honouring `Retry-After`, and the
  model allowlist. It also calls `BudgetGate`, which refuses a call with
  no metered workspace or over `AI_DAILY_BUDGET_USD` and records usage in
  `ai.usage_daily`.
- **Writes are proposals.** The model never calls a write tool. Our code
  checks the structured draft against the workspace first: the client, the
  deal and every rate-card reference must belong to it. Only then does it
  call `/internal/quotes/draft`, which creates a `draft` as the forwarded
  user.

## Phase 5 DoD

| Criterion                                                 | State                                 | Evidence (ran it)                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Isolation suite 0 leaks                                   | Met                                   | `uv run pytest -m isolation`: `12 passed`. That is 11 cases (every HTTP endpoint, all 10 MCP tools and both resources, MCP writes, shared queries) with 0 leaks, plus a control that sees B's data when asking as B. Removing the workspace clause from the retriever, `scoped()` or the view filter fails 3, 7 and 1 cases |
| Eval thresholds met on the recorded run                   | Met, offline model only               | `evals/results/fake-2026-08-09.json` (run at `23ea69b`, also in `ai.eval_runs`): recall@6 1.0 (≥0.85), schema-valid 1.0, isolation leaks 0. Final run `pytest -m eval` on a fresh demo DB: `1 passed`                                                                                                                       |
| …plus one live run logged                                 | **Not done**: needs a key (owner)     | `LLM_PROVIDER=gemini GEMINI_API_KEY=… AI_EVAL_DATABASE_URL=… uv run python -m evals.runner`                                                                                                                                                                                                                                 |
| In-memory MCP client test of every tool in CI             | Met (locally; CI never run on GitHub) | `tests/test_mcp.py`, 6 tests through `mcp.Client(server)` in-process: the tool list equals the design's ten, every tool and both resources as A, cross-tenant denials, per-tool scope refusals, key checks, and `/mcp` over HTTP (401 without or with a bad key). Runs in the `ai` CI job's pytest step                           |
| A drafted quote opens in the builder and saves (E2E)      | Met                                   | `playwright.assistant.config.ts` (web + apps/api + AI service, offline model): `2 passed` (sign-in setup + the spec), CI=1, no retries                                                                                                                                                                                      |
| With ai stopped, reports and the core flow still pass E2E | Met                                   | `playwright.flows.config.ts` now runs with `AI_URL` on a closed port: `20 passed`. That covers lead to paid, quote to paid, Kanban, automations, CSP, axe, the widget and the new `assistant-down` spec (assistant hidden, analytics renders, chat route 502)                                                               |

### Recorded eval run (offline model)

`evals/results/fake-2026-08-09.json`, dataset `40354225e9e4`. The items
are 40 RAG, 20 SQL, 14 quote briefs and 10 isolation/jailbreak prompts.

| Metric                  | Value                                             | Threshold |
| ----------------------- | ------------------------------------------------- | --------- |
| recall@6                | 1.0                                               | ≥ 0.85    |
| schema-valid rate       | 1.0                                               | = 1.0     |
| isolation leaks         | 0                                                 | = 0       |
| citation precision      | 0.9                                               | none      |
| answer correctness, SQL | 1.0                                               | none      |
| answer correctness, RAG | 0.125                                             | none      |
| GST inputs exact        | 1.0                                               | none      |
| client grounding        | 1.0                                               | none      |
| isolation refusal rate  | 1.0                                               | none      |
| p95 latency             | 118 ms                                            | none      |
| cost of the run         | $0.023888 (offline model priced like gpt-4o-mini) | none      |

What these numbers can and cannot show:

- **Offline model.** The run uses the offline model, so it measures our
  pipeline, not a language model: retrieval and SQL routing, schema
  validation, workspace checks and the leak guards.
- **RAG answer correctness (0.125).** The fake answers with one extracted
  sentence, so this number says nothing about a real model.
- **Injection refusal (1.0).** The fake cannot follow injected
  instructions, so this rate is not evidence about a real model.
- **Embeddings are lexical.** The fake's embeddings are a hashed bag of
  words. Recall was 0.625 until the retriever learned to match document
  numbers named in a question (`af0b8d7`). That is a real retrieval
  change, but it was found and measured on this lexical model.

## Deviations and why

1. **Ids in `ai` tables are `text`, not `uuid`.** The design says `uuid`.
   Prisma's ids are `text` columns. A `uuid` column would need a cast in
   every comparison and would reject a malformed id with an error instead
   of "not found". `ai.eval_runs` also has a `provider` column for R30's
   per-provider rows.
2. **A third role.** The login `ai_service` holds `ai_reader` and
   `ai_owner`. The design names only those two roles.
3. **New dependencies the design does not list:**
   - **PyJWT**, for service JWTs; hand-written HMAC verification is the
     riskier choice.
   - **httpx2**, see the next item.
   - **openpyxl**, for the XLSX export.
   - **redis**, for the RPD counter and the jti replay cache.
   - **langchain-text-splitters**, the 1.x home of
     `RecursiveCharacterTextSplitter`.
   - **OpenTelemetry SDK and OTLP exporter.**
   - **pandas-stubs** and **types-openpyxl**, for mypy.
   - **jose** is now a direct dependency of `apps/web` and a runtime
     dependency of `packages/jobs`.
4. **httpx and httpx2.** The pinned `openai==3.22.1` is built on `httpx2`
   (pydantic/httpx2) and type-checks its `http_client` against
   `httpx2.AsyncClient`. The LLM transport, the fake model and the apps/api
   client therefore use `httpx2`. `httpx` remains only because FastAPI's
   in-process test client (`httpx.ASGITransport`) uses it, and only test
   code imports it: `grep -rn "^import httpx$\|^from httpx " services/ai/app`
   finds nothing.
5. **`LLM_PROVIDER=fake`.** This value is not in the design. It is a
   deterministic OpenAI-compatible endpoint implemented as an httpx2
   transport, so the real SDK and LangChain code runs unchanged. It is
   refused when `ENVIRONMENT=production`. The design asks for
   respx-recorded cassettes, but there was no key to record them with.
6. **Chat tokens are streamed after the agent finishes.** They do not come
   from the provider's own token stream. This is so the not-found guard
   (a search that found nothing replaces the answer) and citation cleanup
   run before any text reaches the user.
7. **Answers render as plain text, not sanitised markdown.** Plain text
   leaves no HTML path from model output into the page.
8. **`create_draft_quote` is not a model-callable tool.** Our code calls
   `/internal/quotes/draft` after validating the structured output. This is
   the conservative reading of "writes are proposals".
9. **MCP writes go through two extra internal routes.** `create_lead` and
   `move_deal` write through `/internal/leads` and
   `/internal/deals/:id/move`, which the design's list of internal routes
   does not name. The design requires writes to go through apps/api.
10. **MCP entry points.**
    - **HTTP:** stateless JSON responses mounted at `/mcp`.
    - **stdio:** `uv run python -m app.mcp.stdio` with `<SLUG>_API_KEY`.
      The design says `uv run <product>-mcp`, but the uv project is not an
      installable package.
11. **GST correctness in the evals is measured on the inputs.** The metric
    checks the SAC code and rate sent for pricing. The runner replaces
    apps/api with a recorder so evals never write quotes, and apps/api's
    own tests cover the GST math.
12. **The eval set extends the demo seed.** `seed-demo-ai.ts` adds nine
    rate cards, four signed contracts and three client notes with fixed
    text. The Phase 3 demo seed had no rate cards, no client contracts and
    only lorem-ipsum templates. The new content uses no faker, so the
    seeded faker sequence is unchanged.
13. **Reports are written to a local directory.** They go to
    `AI_REPORTS_DIR`, not S3 (Phase 6 infra). The e-mailed summary, the
    lead scorer and the Lambda replica (`REPORTS_SCHEDULER=lambda`) are
    not built.
14. **The product slug is a setting.** `product_slug` (env `PRODUCT_SLUG`,
    default `wolff`, mirroring `packages/core/src/brand.ts`) drives the API
    key prefix and the MCP server name. There is no new hard-coded
    product name.
15. **GST preview default.** The quote agent prices preview GST at 18% for
    rate cards with no GST rate. The saved draft has tax 0, and the builder
    prices GST on save.

## Known issues and deferred

- **Write paths that emit `ai.index`.** `createQuote`, `updateQuote`,
  `createInvoice` and `updateInvoice` emit it in the change's transaction,
  as does `createDraftQuote`. Status changes, portal acceptance,
  duplicates, recurring copies, contracts and client notes emit nothing.
  The nightly `ai.sweep` (01:30 UTC) re-indexes them, so the index can lag
  up to a day for those.
- **Demo-mode banner (pre-existing).** The banner is fixed over the right
  side of the dashboard header for demo users. The header buttons (the
  assistant, theme, notifications) cannot be clicked until it is
  dismissed, so the assistant E2E dismisses it. Fixing the layout changes
  the visual baselines → Phase 7.
- **Chat and drafts have no per-IP or per-user rate limit in the web
  app.** The AI service's daily budget is the only cap.
- **The trace context does not travel web → api → job → ai.** This is
  Phase 6, as already listed in `phase-4.md`.
- **OAuth on MCP (stretch goal) is not done.** It is the second item on
  the cut list.
- **One unexplained failure.** One full Python suite run (between
  `3136ed3` and `43b98a1`, right after editing) had a single failure whose
  name was not captured. The next 9 full runs, and every run since, are
  green.
- **Mid-history commits that fail a check.** History was not rewritten:
  - From `8d0d005` (the `mcp` dependency brings in `cryptography`, which
    changes PyJWT's types) to before `9c8f8f3`, `mypy --no-incremental`
    fails in `tests/test_auth.py`. Local runs used mypy's cache and showed
    success; the clean final run caught it.
  - From `866bc29` to before `914effe`, `packages/jobs`' Redis-backed
    scheduler test fails with services, because it still expected the
    five pre-Phase-5 schedules.
  - `a27dfbe`'s `assistant-down` spec has a race, fixed by `35eb001`.
- **Commit-message errors.** These are left as they are, because
  rewording needs a backup tag:
  - `b6e8094` uses type `build`, which is not in the allowed commit types; it
    should be `chore`.
  - `2066b77`'s body says the recorded run was "at 0b8b0d5.."; the file
    records `23ea69b`, and its p95 is 118 ms, not 117.
- **The `mcp` deprecation warning is handled.** `validate_token_resource`
  is set to `False` explicitly, because API keys carry no audience and the
  verifier checks the key row instead.

## Mock only / not verified live

- **LLM.** Every chat, embedding, tool call and structured output ran
  against the offline model, and no Gemini or OpenAI request was made.
  Whether Gemini's OpenAI-compatible endpoint honours `dimensions=1536` is
  unverified (`fit_dimensions` truncates and normalises if not). The
  free-tier RPM/RPD/TPM and the model names in `app/llm/providers.py` are
  placeholders to verify at signup.
- **Sentry and OTLP.** Initialisation, scrubbing and FastAPI
  instrumentation are unit-tested; no event was sent.
- **Redis paths.** The Redis-backed jti cache and RPD counter are wired but
  exercised only with their in-memory versions.
- **CI.** CI has never run on GitHub. The new `ai` job and the `e2e`
  additions were emulated step by step locally, as described under "Checks
  at the tip"; `actionlint` passes.

## Needs the owner

- **A Gemini API key.** It is needed for the live eval run and for using
  the assistant with a real model:
  `LLM_PROVIDER=gemini GEMINI_API_KEY=… AI_EVAL_DATABASE_URL=postgresql://ai_service:…@…/<demo-seeded db> uv run python -m evals.runner`,
  which writes `evals/results/gemini-<date>.json` and an `ai.eval_runs`
  row. The signup also verifies the free-tier limits and model names in
  `app/llm/providers.py`.
- **Optional: an OpenAI key.** It would allow the production-provider row
  that R30 asks to gate on.
- **Secrets per environment.** Choose `SVC_JWT_SECRET_WEB`,
  `SVC_JWT_SECRET_WORKER`, `SVC_JWT_SECRET_AI` and `AI_DB_PASSWORD`, and
  run `infra/db/bootstrap.sql` once against Neon.
- **The demo environment.** The Vercel Python project for `ai` and the
  Sentry DSN come with Phase 6's demo environment.

## Checks at the tip

Unless noted, everything ran on 2026-08-09 in a fresh `git worktree` with
no `.env` files. Versions: Node 24.21.0, Python 3.12.13 (uv 0.11.5),
Postgres 17 + pgvector 0.8.2, stripe-mock 0.205.0, Redis 7
(testcontainers). Each suite got a fresh database and the suites ran one
at a time.

The checks ran at three tips:

- **`528dfcd`:** install, type-check, lint, the TS suites with services
  (jobs was rerun at `914effe` after its fix), build, E2E and visual.
- **`914effe`:** the TS suites without services.
- **`9c8f8f3`:** the Python checks, migrations and OpenAPI.

What changed between these tips:

- `914effe` changes one jobs test.
- `9c8f8f3` changes one Python test.

| Check                                                                                      | Result                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm install --frozen-lockfile`                                                           | ok                                                                                                                                                                       |
| `pnpm type-check --force`                                                                  | 14/14 tasks                                                                                                                                                              |
| `pnpm lint`                                                                                | 0 errors (56 web, 2 widget warnings, unchanged from Phase 4)                                                                                                             |
| TS tests with Postgres + stripe-mock + Redis                                               | core 271, jobs 66, database 39, contracts 18, api 199, widget 12, web 1211: all passed                                                                                   |
| TS tests without services                                                                  | core 151 (120 skipped), jobs 44 (22), database 27 (12), contracts 18, api 51 (148), widget 12, web 1167 (44): all passed                                                 |
| `uv run ruff check .` / `ruff format --check .`                                            | all passed / 75 files formatted                                                                                                                                          |
| `uv run mypy` (strict, `--no-incremental`)                                                 | no issues in 73 files                                                                                                                                                    |
| `uv run pytest` (fresh DB: Prisma migrations, bootstrap, Alembic)                          | 139 passed, 1 skipped (the eval test, which needs `AI_EVAL_DATABASE_URL`)                                                                                                |
| `uv run pytest -m isolation`                                                               | 12 passed                                                                                                                                                                |
| `uv run pytest -m eval` (fresh demo-seeded DB)                                             | 1 passed                                                                                                                                                                 |
| `pnpm build`                                                                               | 4/4 tasks                                                                                                                                                                |
| `prisma migrate deploy` + `db:migrate:check`, fresh DB                                     | "No difference detected."                                                                                                                                                |
| `alembic upgrade head` + `alembic check`, same DB                                          | "No new upgrade operations detected."                                                                                                                                    |
| OpenAPI regenerate + `git status`                                                          | no diff                                                                                                                                                                  |
| E2E `playwright.flows.config.ts`, all projects, CI=1, `--retries=0`, AI down               | 20/20                                                                                                                                                                    |
| E2E `playwright.assistant.config.ts`, CI=1, `--retries=0`                                  | 2/2                                                                                                                                                                      |
| Visual, macOS                                                                              | 21/21                                                                                                                                                                    |
| AI image: `docker build`, `alembic upgrade head` in the container, `/healthz`              | ok                                                                                                                                                                       |
| `actionlint .github/workflows/ci.yml`                                                      | ok                                                                                                                                                                       |
| Type-check and lint at each commit that touches TypeScript (13 commits)                    | 13 of 13 pass both                                                                                                                                                       |
| ruff, `mypy --no-incremental` and pytest (no DB) at each commit that touches `services/ai` | 27 commits: ruff and pytest pass at all 27; mypy passes at 17 and fails at the 10 from `8d0d005` to `b6e8094` (the PyJWT typing issue above), passing again at `9c8f8f3` |

Not run:

- GitHub Actions itself.
- Visual baselines in the linux/arm64 container. The launcher renders
  nothing without `AI_URL`, which the visual config does not set; the
  macOS run shows no change.
- A live LLM provider.
