# Phase 2: core + thin API + jobs + outbox + free demo env

Branch `phase2-core-api`, on top of `phase1-upgrades` (`a970c07`).
Phase 2 has a task list and a definition of done.

## What changed

| Area                   | Before             | After                                                                                                                                               | Commit                          |
| ---------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| OpenAPI/Scalar/Postman | None               | `GET /openapi.json`, `GET /docs` (Scalar), `pnpm openapi:postman` generates `docs/api/postman_collection.json`, `openapi:gen` script, CI diff check | `45b073d`, `dcbbbe9`, `24786bc` |
| API entry points       | None               | `apps/api/src/server.ts` (local/ECS), `src/index.ts` (Vercel zero-config), build/start/dev scripts                                                  | `7e91e19`                       |
| Observability          | Config only        | Sentry + OTel init, `/metrics` (Prometheus) on the internal METRICS_PORT                                                                            | `7d2af88`                       |
| Worker                 | Package logic only | `apps/api/src/worker.ts` (long-running), `src/worker-drain.ts` (GitHub Actions), `pnpm worker`, `pnpm worker:drain`                                 | `7d2af88`                       |
| Free demo env          | Not documented     | `docs/free-tier.md`, `.github/workflows/jobs-drain.yml`                                                                                             | `eee6918`                       |

## Definition of done

### `packages/core` and `packages/contracts`

Already present from earlier Phase 2 commits: quotes, invoices, payments,
webhooks, encryption, API-key auth moved to `packages/core`; API envelope,
scopes and webhook schemas in `packages/contracts`.

Evidence: `packages/core/src` and `packages/contracts/src` contain the
domains; tests pass (see Test counts below).

### `apps/api`: auth, inbound webhooks, outbound delivery, OpenAPI

- API key auth with scopes and per-key rate limits: `apps/api/src/middleware/auth.ts`
- Service JWTs on `/internal`: `apps/api/src/middleware/service-jwt.ts`
- Stripe webhooks on two endpoints, loss-free: `apps/api/src/webhooks/`
- Razorpay signature verification ready: `apps/api/src/webhooks/razorpay.ts`
- Outbound webhooks via outbox: `packages/core/src/webhooks/`
- OpenAPI 3.0 document and Scalar UI: `apps/api/src/openapi/`, `GET /docs`

### Worker: outbox relay, recurring, reminders, PDF, email, overdue

- BullMQ worker, schedulers, drain: `packages/jobs/src/bullmq.ts`
- QStash dispatcher and verifier: `packages/jobs/src/qstash.ts`
- Processors for email, PDF, storage, webhooks: `packages/jobs/src/processors/`, `packages/jobs/src/ports/`
- Recurring invoices, reminders, overdue: `packages/core/src/invoices/`

### Free demo env task

Partly done. `docs/free-tier.md` lists the services and their limits as
"verify at signup": no account was created (owner item). The drain
workflow exists (`.github/workflows/jobs-drain.yml`, hourly as the spec
says); until the 2026-08-09 fixes it could not have run, because it never
generated the Prisma client. Not done, and deferred with the demo
environment (Phase 6): the three Vercel projects, Neon `bootstrap.sql`,
Redis Cloud/Supabase setup, the PDF function smoke test (Chromium cold
start), the `ai` bundle-size check, and the uptime check. The Vercel
recurring-invoice cron was removed on 2026-08-09; `/api/cron/reset-demo`
stays until a `demo.reset` job exists.

### DoD evidence

| Criterion                                                           | Evidence                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recurring job runs twice and produces one invoice per parent+period | `packages/core/src/invoices/scheduled.test.ts` lines 132–164                                                                                                                                                                                       |
| Chaos test: kill Redis, event reconciled by sweeper                 | `packages/jobs/src/bullmq.test.ts` "when Redis is lost"                                                                                                                                                                                            |
| Stripe test event delivered to old + new endpoint processed once    | Not true at Phase 2's close: the Next route still deduped on `stripe_webhook_events`. Fixed 2026-08-09; `apps/web/__tests__/api/stripe-webhook-cutover.integration.test.ts` sends one event to each endpoint in both orders                        |
| Cross-tenant suite green                                            | At Phase 2's close only webhook endpoints had isolation tests, and they passed with the guard off. Since 2026-08-09: `apps/api/src/routes/v1/cross-tenant.test.ts` covers every /v1 route that takes an id                                         |
| Postman collection green                                            | **Not met.** The collection is only generated (`pnpm --filter @wolff/api openapi:postman`, also in CI); no request in it has been run (no Newman run). The file is not committed. Whether the converter's output is deterministic was not measured |
| One trace spans api → job                                           | **Partial**: OTel SDK is initialized and auto-instrumentations are enabled; explicit trace context propagation through BullMQ/QStash is not yet wired. Deferred to Phase 6 observability hardening.                                                |

## Test counts

Run with Postgres 17 and stripe-mock:

```bash
TEST_DATABASE_URL=postgresql://wolff:wolff_dev_only@localhost:5432/wolff?schema=public \
STRIPE_MOCK_URL=http://localhost:12111 \
pnpm test
```

| Package          | Files         | Tests       |
| ---------------- | ------------- | ----------- |
| @wolff/api       | 7             | 91 passed   |
| @wolff/contracts | (in api/core) | —           |
| @wolff/core      | (multiple)    | all green   |
| @wolff/database  | (multiple)    | all green   |
| @wolff/jobs      | 4             | 49 passed   |
| @wolff/web       | 73            | 1123 passed |

Total: **0 failed**.

## Build, lint, type-check, migrations

Prerequisites: Docker Desktop is running with the containers from
`docker compose up` (Postgres 17, Redis, stripe-mock).

```bash
pnpm lint        # 0 errors
pnpm type-check  # all packages pass; Prisma client is generated via turbo dependency
pnpm build       # Next.js 16 + api tsc pass
SHADOW_DATABASE_URL=postgresql://wolff:wolff_dev_only@localhost:5432/wolff_shadow?schema=public \
  pnpm db:migrate:check  # "No difference detected."
```

## Deviations and known issues

0. **Scheduled jobs run from QStash schedules, not the GitHub Actions cron
   (deliberate deviation from the plan, owner decision 2026-08-23).** The
   repo is not pushed, so `jobs-drain.yml` has never run, and the deployed
   demo left emails and webhook deliveries pending until a drain was run by
   hand. Seven QStash schedules (`QSTASH_SCHEDULES` in
   `packages/jobs/src/qstash.ts`, synced with `pnpm --filter @wolff/api
schedules:sync`) now call the signed `/jobs/run/:type` route directly:
   the outbox sweep and automations tick every 15 minutes, recurring
   invoices and the AI sweep hourly, reminders, overdue marking and the
   nightly reports daily (about 245 of QStash's 1,000 free messages a day,
   7 of 10 schedules). The outbox sweep now also relays due events, and
   every scheduled job is bounded to finish inside Vercel's 300 s limit.
   `jobs-drain.yml` stays as a manual (`workflow_dispatch`) workflow.
1. **Distributed trace api → job**: OTel auto-instrumentations cover HTTP
   and Node libraries, but trace context is not explicitly propagated in
   the BullMQ job data or QStash headers. The DoD is marked partial and
   deferred to Phase 6.
2. ~~Redis in local compose~~: Added in the closing commit; `docker compose
up` now includes Redis on `localhost:6379`.
3. **Full `/api/v1` parity port**: explicitly Phase 6b in the spec; the
   existing Next `/api/v1` routes remain in place.
4. **services/ai**: not built in this phase; Phase 5.
5. **Visual regression baselines**: the committed Playwright baselines
   were generated on Linux/arm64. Running `pnpm test:visual` on macOS
   fails due to font rasterisation differences; use the Linux Docker
   image documented in `apps/web/e2e/visual/run-in-linux.sh` or the
   `e2e` CI job.
6. **Partial unique index**: the migration
   `20260716135000_invoice_recurring_period_key` creates the partial
   unique index `invoices_parent_period_key` (`WHERE parent_invoice_id IS
NOT NULL AND recurring_period_key IS NOT NULL`). Prisma's schema cannot
   express it; `prisma migrate diff` reports no difference, and the index
   exists only in the migration SQL.

## Review findings and fixes

A peer review of `phase1-upgrades..phase2-pre-review-fixes`
found the issues below. All CRITICAL, HIGH and MEDIUM findings were
fixed; LOW findings are documented above.

| #   | Severity | File                                                                                                       | Lines     | Finding                                                                                                                                                                  | Fix                                                                                                                                                           |
| --- | -------- | ---------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | HIGH     | `turbo.json`                                                                                               | 24, 28    | `type-check` and `test` only depended on `^build`, so the generated Prisma client was missing on a clean checkout.                                                       | Added the package's own `build` to `dependsOn` for `lint`, `lint:fix`, `type-check` and `test`.                                                               |
| 2   | MEDIUM   | `docs/api/postman_collection.json`                                                                         | —         | The committed Postman collection was non-deterministic and not guarded by CI.                                                                                            | Removed the committed file, added it to `.gitignore`, kept `pnpm openapi:postman` for on-demand generation, and added a CI step that proves generation works. |
| 3   | MEDIUM   | `docs/phase-2.md`                                                                                          | —         | Verification steps did not mention the `db:generate` prerequisite.                                                                                                       | Documented the Docker compose prerequisites and noted that `type-check`/`test` now trigger Prisma client generation via turbo.                                |
| 4   | MEDIUM   | `packages/database/prisma/seed.ts`                                                                         | 1143–1150 | Demo seed cleanup deleted invoices before their payment schedules and payments, failing on the second seed with a foreign-key constraint.                                | Delete `paymentSchedule` and `payment` rows before `invoice` rows in the cleanup block.                                                                       |
| 5   | MEDIUM   | `packages/jobs/src/bullmq.test.ts`                                                                         | 330–335   | `relays on a timer` did not scope the outbox relay to events created by the suite, so it processed leftover events from the seeded demo workspace and sent extra emails. | Pass `relay: { ids: mine }` to `startOutboxRelay` in the test.                                                                                                |
| 6   | LOW      | `docs/phase-2.md`                                                                                          | —         | Visual tests fail on macOS against Linux baselines.                                                                                                                      | Documented in "Deviations and known issues".                                                                                                                  |
| 7   | LOW      | `packages/database/prisma/migrations/20250815000000_add_invoice_parent_period_partial_index/migration.sql` | —         | Partial unique index cannot be represented in `schema.prisma`.                                                                                                           | Documented in "Deviations and known issues".                                                                                                                  |

## Owner decisions / blockers

None new. See "Free demo env task" above. The free-tier account creation is documented but not executed;
limits are marked "verify at signup".

## Second review (2026-08-09)

A later review of Phases 2–4 found Phase 2 problems that this document had
reported as done. They are fixed on `phase4-rtk-widget-automation`; the
details and evidence are in `docs/phase-4.md`, "Review findings and fixes":
the push dispatch blocking payment reconciliation (H4), the drain workflow
never generating the Prisma client (H5), the old Stripe endpoint not using
`ProviderWebhookEvent` (H6), Idempotency-Key leases and stored secrets
(M1), the missing cross-tenant suite (M2), `prisma.config.ts` precedence
(M10), dead-lettering of provider events (L1), QStash exhaustion,
`/metrics`, burst and auth-failure rate limits, the SSRF ranges (L2), and
the Vercel cron (L5). The test counts above are as recorded at Phase 2's
close and were not re-run; current counts are in `docs/phase-4.md`.

## Verified on the deployed demo (2026-08-20)

Run against the free demo (Vercel Hobby, Neon, Redis Cloud, Upstash QStash,
Supabase Storage, Sentry, Stripe and Razorpay test mode, Gemini free tier)
from commits `8011d97` and `6c1748c`. Account-specific evidence (ids,
timestamps) is kept outside the repo.

- QStash delivers immediate jobs to `/jobs/run/:type`, which verifies the
  signature (`payments.reconcile`, `pdf.render`, `webhooks.deliver`).
  Found and fixed on the deployed api: the webhook handlers pushed jobs
  after answering, and Vercel froze the function mid-publish (`6c1748c`).
- `worker:drain` from a local machine against Redis Cloud and Neon relays
  the pending outbox rows and runs the due jobs (0 remaining).
- `pdf.render` stores a PDF in Supabase Storage through the S3 API and
  sets `pdf_url`. Open issue: with Vercel Authentication on the web
  project, the renderer captures Vercel's login page instead of the
  invoice.
- The same Stripe event sent to the old web endpoint and the api endpoint
  (both orders) is stored once and applied once.
- An outbound webhook test event reaches an external receiver, signed.
  Open issue: outbox work other than inbound webhooks (emails, outbound
  deliveries) waits for the drain, which has no scheduled runner yet.
- Demo mode sends every email to the redirect address; a payment receipt
  arrived there.
