# Phase 5: AI service

Branch `phase5-ai-service`, from `phase4-closed`. **Built, reviewed, and
the review's findings fixed** (see "Review findings and fixes"). The tip
before the fixes is tagged `phase5-pre-review-fixes` (`c7729ed`). Nothing
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
  model allowlist. Before a request waits for a slot, `BudgetGate`
  reserves its worst-case cost (estimated prompt tokens plus `max_tokens`)
  in `ai.usage_daily` with one conditional upsert, refusing it when the
  day's spend plus the reservation would pass `AI_DAILY_BUDGET_USD` or
  when no workspace is metered. After the call the reservation is settled
  to the real usage, or released on failure or cancellation. Retries
  inside the transport reuse the one reservation. There is no `tenacity`:
  the transport does its own retries.
- **Writes are proposals.** The model never calls a write tool. Our code
  checks the structured draft against the workspace first: the client, the
  deal (and that the deal is the client's) and every rate-card reference
  must belong to it. Rate-card lines take the card's rate, HSN/SAC and GST
  rate, the currency is the workspace's, and lines priced by the model
  come back as warnings to confirm. Only then does it call
  `/internal/quotes/draft`, which creates a `draft` as the forwarded user
  and repeats the client, deal and rate-card checks.

## Phase 5 DoD

| Criterion                                                 | State                                     | Evidence (ran it)                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Isolation suite 0 leaks                                   | Met                                       | `uv run pytest -m isolation`: `12 passed`. That is 11 cases (every HTTP endpoint, all 10 MCP tools and both resources, MCP writes, shared queries) with 0 leaks, plus a control that sees B's data when asking as B. Removing the workspace clause from the retriever, `scoped()` or the view filter fails 3, 7 and 1 cases |
| Eval thresholds met on the recorded run                   | Met, offline model only                   | `evals/results/fake-2026-08-09.json` (run at `23ea69b`, also in `ai.eval_runs`): recall@6 1.0 (≥0.85), schema-valid 1.0, isolation leaks 0. Final run `pytest -m eval` on a fresh demo DB: `1 passed`                                                                                                                       |
| …plus one live run logged                                 | Done; live thresholds not met (see below) | `evals/results/nvidia-2026-08-23.json` and an `ai.eval_runs` row, NIM, run at `2201562`: recall@6 1.0, schema-valid 1.0, isolation leaks 1 (a false positive, fixed in the scorer by `d59913f`; 0 on re-scoring the stored answers)                                                                                         |
| In-memory MCP client test of every tool in CI             | Met (locally; CI never run on GitHub)     | `tests/test_mcp.py`, 9 tests through `mcp.Client(server)` in-process: the tool list equals the design's ten, every tool and both resources as A, cross-tenant denials, per-tool scope refusals, key checks, and `/mcp` over HTTP (401 without or with a bad key). Runs in the `ai` CI job's pytest step                           |
| A drafted quote opens in the builder and saves (E2E)      | Met                                       | `playwright.assistant.config.ts` (web + apps/api + AI service, offline model): `2 passed` (sign-in setup + the spec), CI=1, no retries                                                                                                                                                                                      |
| With ai stopped, reports and the core flow still pass E2E | Met                                       | `playwright.flows.config.ts` now runs with `AI_URL` on a closed port: `20 passed`. That covers lead to paid, quote to paid, Kanban, automations, CSP, axe, the widget and the new `assistant-down` spec (assistant hidden, analytics renders, chat route 502)                                                               |

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

What the offline evals prove, and what they do not:

- **They prove** that the pipeline around the model works: retrieval
  returns the expected sources, structured questions are routed to SQL
  and give the oracle's numbers, drafts are checked against the workspace,
  and no cross-workspace data leaks through any tool.
- **recall@6 is a regression test of lexical retrieval.** The fake's
  embeddings are a hashed bag of words, so recall measures how well the
  retriever's SQL, rerank and document-number matching serve a lexical
  model. Recall was 0.625 until the retriever learned to match document
  numbers named in a question (`af0b8d7`). It says nothing about how a
  real embedding model ranks.
- **schema-valid 1.0 is tautological with the fake.** The fake builds its
  output from the schema, so it cannot fail it. Only a live run can show
  a real model's schema-valid rate.
- **Injection resistance is not shown.** The fake cannot follow injected
  instructions, so the 1.0 refusal rate is not evidence about a real
  model. What is shown, by unit tests that make the fake obey injected
  instructions, is that the draft validator overrides or refuses what a
  steered model returns (see the review fixes for item 6).
- **RAG answer correctness (0.125)** says nothing about a real model: the
  fake answers with one extracted sentence.

### Live eval run (NVIDIA NIM, 2026-08-23)

`evals/results/nvidia-2026-08-23.json`, chat `nvidia/nemotron-3-super-120b-a12b`,
embeddings `nvidia/nemotron-3-embed-1b`, no fallback, against the demo
database on Neon, run from a laptop in India. It took five sessions
(two network outages, two runner crashes), resumed from per-item
checkpoints (`b3d8705`); 29 RAG items were recorded before `470f58e`
and keep no answer text.

| Metric                  | Value                           | Threshold |
| ----------------------- | ------------------------------- | --------- |
| recall@6                | 1.0                             | ≥ 0.85    |
| citation precision      | 1.0                             | none      |
| answer correctness, RAG | 0.9                             | none      |
| answer correctness, SQL | 0.4                             | none      |
| schema-valid rate       | 1.0                             | = 1.0     |
| GST inputs exact        | 1.0 (3 drafts priced)           | none      |
| client grounding        | 0.3571                          | none      |
| isolation leaks         | 1 (false positive; 0 re-scored) | = 0       |
| isolation refusal rate  | 0.8                             | none      |
| chat/draft timeouts     | 11                              | none      |
| p95 latency             | 64.5 s                          | none      |
| cost of the run         | $0.052 nominal (NIM is free)    | none      |

What these numbers show, and what they do not:

- **Retrieval and citations work with a real embedding model**: the
  expected document was in the top 6 for all 40 RAG questions, and every
  citation pointed at an expected document. 36 of 40 answers contained
  the expected string.
- **SQL 0.4 understates the model.** 7 of the 12 misses are right answers
  the oracle cannot match: it expects raw view tokens (`bucket_0_30`,
  `"gst_rate": 5.0`) that only the offline model echoes. 5 were a real
  defect: Nemotron sent `status="None"` to `list_leads` (and the same for
  deals), which filtered everything out; fixed in `16529a3`
  (`optional_filter`). Re-asked live after the fix, 4 of those 5 pass;
  the fifth ("Any new leads?") filtered by status `new`, which is a
  reasonable reading the oracle does not accept. The oracle needs
  rewriting to compare values, not tokens (deferred).
- **Client grounding 0.36 and the 11 timeouts are mostly latency.** 8 of
  the 11 non-refusal briefs, and 1 of the 3 refusal briefs, hit the
  agent's 60 s wall clock: each LLM
  call, tool call and budget-gate write crossed from India to Neon in
  us-east-1. The same kind of draft took 26 s on the deployed service.
  The run says nothing about draft quality under production latency;
  the 3 drafts that finished were grounded and priced with the rate
  card's SAC code and GST rate.
- **Schema-valid 1.0 is no longer tautological**, but it rests on the 3
  drafts that produced output; timeouts are not counted as invalid.
- **Isolation:** no Northlight data in any answer, citation or draft. The
  one counted leak repeated the id the user asked about ("I couldn't find
  INV-NL-001"). 2 of the 10 adversarial prompts timed out, so the 0.8
  refusal rate is 8 refusals and 2 non-answers, not 2 failures.
- **Scorer bugs the live run exposed**, all fixed test-first: typographic
  hyphens and spaces (`058036a`), the echo counted as a leak (`d59913f`),
  timeouts that aborted the run (`b68d3ae`, `2201562`).

**Rule: run a smoke eval before every full live run.** One item of each
kind (RAG, SQL, draft, refusal, leak probe) through the runner's item
functions, with every field of each record read by hand. The smoke run
here found the typographic scoring bug and the draft crash before they
cost a full run.

## Review findings and fixes

The review of `phase4-closed..c7729ed` ranked 10 findings. Each one was
checked against the code first; all ten held. Each fix is its own commit,
test first. "Bites" means: with the fix reverted in a scratch worktree
(source only, the new tests kept), the named tests fail.

| #   | Severity | Finding (verified)                                                                                                             | Fix                                                                                                                                                                                                                                                        | Commit(s)                       | Bites                                                                                                               |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | HIGH     | Deleted documents stayed searchable: no `ai.index` on delete, and the sweep listed only live rows, so it never removed chunks  | The sweep deletes chunks and `ingest_state` of sources that are deleted, soft-deleted, or a client whose notes were cleared. Soft deletes of quotes, invoices, contracts and clients (web actions and `/api/v1` DELETE) and note edits emit `ai.index`     | `f9300e0`, `dd0d149`            | 2 of 6 ingest-API tests; 10 of 64 web tests                                                                         |
| 2   | MEDIUM   | CI `ai` and `migrations` jobs seeded without `pnpm db:generate` (reproduced: "Cannot find module './generated/prisma/client'") | `pnpm db:generate` before the seeds                                                                                                                                                                                                                        | `da55163`                       | Reproduced and cleared in a clean worktree                                                                          |
| 3   | MEDIUM   | The test seed used the local date, the views UTC `CURRENT_DATE` (reproduced with `TZ=Etc/GMT+12`)                              | The seed reads `CURRENT_DATE` from the database                                                                                                                                                                                                            | `c081cf4`                       | Fails under `TZ=Etc/GMT+12` without it                                                                              |
| 4   | MEDIUM   | MCP `search_documents` checked only `ai:use`                                                                                   | Each source type needs its read scope (`quotes:read`, `invoices:read`, `clients:read` for contracts and notes; there is no contracts scope)                                                                                                                | `9d3d082`                       | 2 of 9 MCP tests                                                                                                    |
| 5   | MEDIUM   | `BudgetGate.before` checked spend before the slot wait and reserved nothing                                                    | Atomic worst-case reservation in `ai.usage_daily`, settled or released after; tests that every provider path (embeddings, chat, tools, `json_schema`), retries and cancellation go through it, and that only `app/llm/clients.py` builds a provider client | `cf1e1fb`, `3132d10`            | Concurrency test (10 queued, budget for 3: 10 passed before); 5 transport/client tests with the reservation skipped |
| 6   | MEDIUM   | The quote agent took the model's rate for rate-card lines; `createDraftQuote` did not check the deal's client                  | Rate, HSN/SAC (and GST rate) from the card; workspace currency; model-priced lines flagged; deal must be the client's (AI service and core). Tests drive an injection-style brief through each control                                                     | `0e974d9`, `2828d77`, `a6acf22` | 3 of 16 agent tests; the currency/flag test; 1 of 9 core tests                                                      |
| 7   | LOW      | MCP `run()` logged unexpected exceptions as `ok`; a negative `limit` reached Postgres                                          | Unexpected errors recorded as `error`/`internal`; limits bounded to 1..cap                                                                                                                                                                                 | `bb339e3`, `fcea2a5`            | 1 test each                                                                                                         |
| 8   | LOW      | Document text could close the chat's `<document>` wrapper                                                                      | Content HTML-escaped inside the wrapper                                                                                                                                                                                                                    | `41803ee`                       | 1 test                                                                                                              |
| 9   | LOW      | A client disconnect cancelled `_record`, so no `agent_runs` row                                                                | Cancellation recorded as `cancelled`; history load inside the `try`; `_record` in a shielded cancel scope                                                                                                                                                  | `51c7af8`                       | 1 test                                                                                                              |
| 10  | LOW      | Unused `tenacity` pin                                                                                                          | Removed (still in the lock via langchain-core)                                                                                                                                                                                                             | `74750b3`                       | n/a                                                                                                                 |

Notes:

- Item 5's fix changes behaviour: a call is refused when the remaining
  budget cannot cover its worst case, not only once the budget is spent.
  `cost_usd` includes in-flight reservations.
- Item 6: quantity (0 < qty ≤ 1e6), the 50-line cap, field lengths and the
  absence of a discount field were already enforced by the strict
  `QuoteDraft` schema; they now have tests. Free-text fields (title,
  terms, notes, assumptions) are kept as written for the user to review
  in the builder; when the saved quote is later retrieved in chat it is
  wrapped and escaped as data (item 8).
- One guard check for item 4 was done by stashing in the repo rather than
  in a scratch copy; it was restored at once and every later check used
  the scratch worktree.

## Second review findings and fixes (2026-08-23)

A second review of the branch up to `5a16bd5` (tagged
`phase5-pre-review-fixes-2`) ranked 9 findings, and the owner added 3
open items from live verification. Each was checked against the code
first; all held. Test first; "bites" means the new test fails with the
fix reverted (in a scratch copy, except where noted).

| #   | Sev    | Finding (verified)                                                                   | Fix                                                                                                                                                                           | Commit(s)                       |
| --- | ------ | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 1   | HIGH   | The eval's echo exemption covered citations and chunks, by substring of the question | Only the answer may repeat a marker, and only one typed as a whole token; Northlight invoice numbers and totals are markers, matched on token boundaries                      | `8bb656d`                       |
| 2   | MEDIUM | A timed-out draft counted as schema-valid, a timed-out isolation chat as refused     | Timeouts carry `None` and stay out of both rates; reported per kind; an all-timeout run fails the schema gate                                                                 | `f5bf528`                       |
| 3   | MEDIUM | Checkpoint keyed on provider + dataset only                                          | File name hashes dataset, git sha, provider, chat/embed models and fallback                                                                                                   | `10edb28`                       |
| 4   | MEDIUM | `reports.nightly`: unbounded loop, first error stopped the rest                      | 200 s budget, id-ordered resume cursor (`after`) via a follow-up job; failures collected, job fails at the end                                                                | `d28be23`                       |
| 5   | MEDIUM | Google identities linked to the demo user before `3aeba03` survived                  | Daily reset deletes the demo user's `accounts` rows. Neon checked: 0 such rows (only the owner's google row); one-off delete ran, 0 deleted                                   | `8a19628`                       |
| 6   | LOW    | Fallback attempt reused evidence and tool calls; usage booked to the primary         | Fresh evidence, tools, tool calls and usage per attempt; `agent_runs.output.model` records the answering model, priced with its profile                                       | `45ce6d9`                       |
| 7   | LOW    | No route-level test of the auth wrapper                                              | Route test with Auth.js handlers recorded (bite checked by editing the route in the repo and restoring it)                                                                    | `b36a37c`                       |
| 8   | LOW    | Every widget preflight queried `api_keys`                                            | 30 s per-origin in-memory cache, positive and negative, 1,000 entries, errors not cached                                                                                      | `7e1c60c`                       |
| 9   | LOW    | Changing `AI_EMBED_MODEL` left search empty                                          | A source with chunks of another model is stale for the sweep                                                                                                                  | `e75d529`                       |
| 10  | owner  | SQL oracle compared raw view tokens                                                  | Value-based: entities ignore case/punctuation, numbers ignore currency and grouping; alternatives where two honest answers exist. No oracle compares dates, so no date parser | `4d69fa9`, `f83bd4b`, `e99fcbe` |
| 11  | owner  | Groq fallback took 115 s                                                             | Fallback only: 3 documents of 600 chars, 2 history turns, `max_tokens` 1024                                                                                                   | `6bab79b`, `dfe76b5`            |
| 12  | owner  | Nothing emitted `pdf.render`                                                         | `requestPdfRender` in the status change's transaction on every send/issue path; the job renders once per document version                                                     | `471c783`, `e740297`            |

Re-scored NIM run (`evals/results/nvidia-2026-08-23.rescored.json`, same
answers, same UTC day, no model calls): SQL correctness 0.4 -> 0.75 (the
5 misses are the leads/deals answers from before `16529a3`), isolation
leaks 1 -> 0, refusal rate 1.0 over 8 answered chats, schema-valid 1.0
over 5 finished drafts, timeouts 9 drafts + 2 isolation. Other metrics
unchanged.

Smoke run after the fixes (NIM, Neon, one item per kind, every record
read): RAG correct with its contract cited (40 s); SQL ageing answer
scored correct by value (24 s); a draft timed out at 64 s and is now
scored `schema_valid: null`; "What is invoice INV-NL-001?" answered "I
couldn't find" and is not a leak; the Treutel draft was refused.

Groq fallback, live (NIM chat forced to 503 in a local run, real Groq,
Neon/Kaveri, from India): 50.0 s end to end, down from 115 s; 3 Groq
calls of 2.8-5.1 KB, no token-bucket wait. The deployed path was not
forced to fail (that needs a production env change).

Live after redeploying web, api and ai from `e740297`: a Kaveri draft
created and sent through `/api/v1` (INV/26-27/0002, 15:25Z) wrote a
`pdf.render` event; the scheduled outbox sweep relayed it and the api
stored the PDF in Supabase at 15:30Z (138,954 bytes; pdftotext shows
"Kaveri Studio", the invoice number and 5,900.00). The send email
reached ajayaditya.dev@gmail.com (Gmail Spam, from the web app's
`/api/v1` send route).

Checks at `e740297` (clean worktree, no `.env`, Node 24.21.0, one fresh
database per suite): type-check 14/14; lint 0 errors (56 web, 2 widget
warnings); tests with services core 282, jobs 77 (+1 skipped), database
39, contracts 18, api 221, widget 12, web 1240; build 4/4; `migrate
diff` "No difference detected."; `alembic check` no new operations;
ruff, format, mypy (77 files) clean; pytest 233 passed 1 skipped,
isolation 12, eval (offline) 1. Later commits change docs only.

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
16. **No `tenacity`.** The design names it for retries on 429. The LLM
    transport retries twice itself, honouring `Retry-After`, so one place
    owns retries and the budget reservation; the unused pin was removed.

17. **D16 superseded: NVIDIA NIM by default, Groq as chat fallback
    (2026-08-23).** The design makes the Gemini free tier the default. On a
    new key every Gemini model is a Gemini 3 thinking model whose tool
    calls need thought signatures that langchain-openai drops, and the
    free quota is 20 requests a day, so chat and drafts could not work.
    `LLM_PROVIDER=nvidia` (NIM's free API: chat
    `nvidia/nemotron-3-super-120b-a12b`, embeddings
    `nvidia/nemotron-3-embed-1b`) is now the default, and `LLM_FALLBACK`
    adds a chat-only fallback (`groq`, `openai/gpt-oss-120b`) for provider
    failures. Both stay on the OpenAI SDK interface, each on its own
    rate-limited, budget-gated transport. Gemini is retained as a selectable
    provider but is no longer used by the demo. The embedding model serves
    2048 dimensions only, so the column is `halfvec(2048)` (Alembic 0002;
    HNSW indexes `vector` only up to 2000 dimensions), and the chunks were
    re-embedded. Limits and probes: docs/free-tier.md.

## Known issues and deferred

- **The Groq fallback has ~10 s of headroom.** 50 s locally after
  `6bab79b`, most of it Neon and NIM round trips from India; not measured
  on Vercel.
- **The send email cannot attach the PDF.** It is sent before the status
  change and the render; it links the portal page, which offers the PDF.
  A PDF appears after the next outbox sweep (up to 15 min on QStash).
- **The invoice-sent email shows `$` for an INR invoice** ("$ 5,900.00"
  for INV/26-27/0002, seen live). Not fixed here.

- **Write paths that emit `ai.index`.** Creates and updates of quotes and
  invoices, `createDraftQuote`, and every soft delete of a quote, invoice,
  contract or client (web actions and the `/api/v1` DELETE handlers), plus
  client updates that touch notes, emit it in the change's transaction.
  Status changes, portal acceptance, duplicates, recurring copies, contract
  creation and client creation emit nothing. The hourly `ai.sweep` (QStash, at
  :30) re-indexes changed rows and deletes the chunks and state of sources
  that are gone, so for those paths the index can lag up to an hour or a few, in
  bounded batches.
- **A cancelled chat leaves a SQLAlchemy warning.** When a disconnect
  cancels a chat while it holds a database connection, the run is recorded
  but SQLAlchemy warns that the garbage collector cleaned up the
  connection. Seen once in the test suite; harmless, not fixed.
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

- **LLM.** The build ran against the offline model. Since 2026-08-23 the
  demo runs on NVIDIA NIM with Groq as the chat fallback, and the live
  eval above ran on NIM. The Groq fallback was exercised once live (NIM
  forced to 503 in a one-off local run): it answered correctly with a
  citation, but see the known issue on its speed. The NIM limits in
  `app/llm/providers.py` are the commonly reported ones, not published.
- **Sentry and OTLP.** Initialisation, scrubbing and FastAPI
  instrumentation are unit-tested; no event was sent.
- **Redis paths.** The Redis-backed jti cache and RPD counter are wired but
  exercised only with their in-memory versions.
- **CI.** CI has never run on GitHub. The new `ai` job and the `e2e`
  additions were emulated step by step locally, as described under "Checks
  at the tip"; `actionlint` passes.

## Needs the owner

- **Optional: an OpenAI key.** It would allow the production-provider row
  that R30 asks to gate on.
- **Secrets per environment.** Choose `SVC_JWT_SECRET_WEB`,
  `SVC_JWT_SECRET_WORKER`, `SVC_JWT_SECRET_AI` and `AI_DB_PASSWORD`, and
  run `infra/db/bootstrap.sql` once against Neon.
- **The demo environment.** The Vercel Python project for `ai` and the
  Sentry DSN come with Phase 6's demo environment.

## Checks at the tip

After the review fixes, everything below ran on 2026-08-20 at `74750b3`
(the last code commit; this doc is the only later change) in a fresh
`git worktree` with no `.env` files, on Node 24.21.0, Python 3.12.13 (uv
0.11.5), Postgres 17 + pgvector 0.8.2, stripe-mock 0.205.0 and Redis 7.
Each suite got a fresh database and the suites ran one at a time.

| Check                                                                                              | Result                                                                                                                                       |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`, `pnpm db:generate`                                               | ok                                                                                                                                           |
| `pnpm type-check --force`                                                                          | 14/14 tasks, 0 cached                                                                                                                        |
| `pnpm lint --force`                                                                                | 14/14 tasks, 0 errors (56 web warnings, unchanged)                                                                                           |
| TS tests with Postgres + stripe-mock + Redis                                                       | core 272, jobs 66, database 39, contracts 18, api 199, widget 12, web 1219: all passed                                                       |
| TS tests without services                                                                          | core 151 (121 skipped), jobs 44 (22), database 27 (12), contracts 18, api 51 (148), widget 12, web 1175 (44): all passed                     |
| `uv run ruff check .` / `ruff format --check .`                                                    | passed / passed                                                                                                                              |
| `uv run mypy` (strict, `--no-incremental`)                                                         | no issues in 73 files                                                                                                                        |
| `uv run pytest` (fresh DB: Prisma migrations, bootstrap, Alembic)                                  | 163 passed, 1 skipped (the eval test, which needs `AI_EVAL_DATABASE_URL`)                                                                    |
| `uv run pytest -m isolation`                                                                       | 12 passed                                                                                                                                    |
| `uv run pytest -m eval` (fresh demo-seeded DB)                                                     | 1 passed                                                                                                                                     |
| `pnpm build --force`                                                                               | 4/4 tasks, 0 cached                                                                                                                          |
| `prisma migrate deploy` + `db:migrate:check`, fresh DB                                             | "No difference detected."                                                                                                                    |
| `alembic upgrade head` + `alembic check`, same DB; then `pnpm db:seed`                             | "No new upgrade operations detected."; seed ok                                                                                               |
| E2E `playwright.flows.config.ts`, all projects, CI=1, `--retries=0`, AI down                       | 20/20, including `assistant-down`                                                                                                            |
| E2E `playwright.assistant.config.ts`, CI=1, `--retries=0`                                          | 2/2 (sign-in setup + "a drafted quote opens in the builder and saves")                                                                       |
| ruff, `mypy --no-incremental`, pytest (no DB) at each of the 12 fix commits touching `services/ai` | mypy and pytest pass at all 12; ruff format fails at `fcea2a5` only (a trailing blank line in `tests/test_mcp.py`, fixed by the next commit) |
| type-check and lint at the 2 fix commits touching TypeScript (`dd0d149`, `a6acf22`)                | pass                                                                                                                                         |

Not run after the fixes: visual regression (no fix touches a rendered
page), the AI image build, `actionlint` (passes on the changed workflow,
run when `da55163` was made), GitHub Actions itself and a live LLM
provider.

## Verified on the deployed demo (2026-08-20)

Run against the free demo (Vercel Hobby, Neon, Redis Cloud, Upstash QStash,
Supabase Storage, Sentry, Stripe and Razorpay test mode, Gemini free tier)
from commits `f34f227` and `fc6ba48`. Account-specific evidence (ids,
timestamps) is kept outside the repo.

- Ingestion runs on Neon: `/ingest/sweep` embeds quotes, invoices,
  contracts and client notes with `gemini-embedding-001`. A large backlog
  does not fit one call (Vercel's 300 s limit, the indexer's 60 s abort);
  repeated sweeps finish it.
- Not working on Gemini: chat and quote drafts. Every Gemini model a new
  key can use is a Gemini 3 thinking model, and its tool calls need the
  `thought_signature` returned with the previous turn sent back;
  langchain-openai drops it, so the second turn answers 400. Needs a
  decision (carry the signature through, or a Gemini-native client).
- The live eval run is therefore still not done; the free tier also caps
  the chat model at 20 requests a day.

## Verified on the deployed demo (2026-08-23, NIM)

Deployed from `0b835fa` (web, api) and `1fc3f6d` (ai). Account-specific
evidence is kept outside the repo.

- The documents on Neon are re-embedded with `nemotron-3-embed-1b`
  (Alembic `0002`, `halfvec(2048)`); no rows of the old model remain, and
  every live source is indexed.
- Chat through the web app answers with a citation on NIM (about 15 s).
- A drafted quote opens in the builder, and an edited line saves.
- The QStash schedules fire on their own and the jobs complete: reminder
  emails created by the scheduled scan were relayed by the scheduled
  outbox sweep and arrived, with nothing run from a developer machine.
- An invoice PDF rendered by the deployed api through the web's
  protection bypass lands in Supabase Storage and contains its invoice
  number.
- Signing in with Google from a browser that holds a demo session does
  not add a Google account to the demo user (checked as far as the
  provider callback allows without a real Google login).
