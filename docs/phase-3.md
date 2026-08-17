# Phase 3: CRM + GST + Razorpay + demo seed

Branch `phase3-crm-gst-razorpay`, on top of `phase2-core-api`.
Phase 3 has a task list and a definition of done.

## What changed

| Area                                  | Before                                  | After                                                                                                | Commit               |
| ------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------- |
| CRM models                            | None                                    | `Lead`, `Pipeline`, `Stage`, `Deal`, `DealActivity` with migrations                                  | `35c5a01`            |
| GST models/fields                     | None                                    | GST fields on invoices, line items, clients, business profiles; GST enums                            | `25140b0`            |
| Recurring invoice numbering           | Used old `NumberSequence` key           | Updated to composite `workspaceId_type_financialYear` key                                            | `e5c63ab`            |
| CRM core                              | None                                    | `packages/core/src/crm`: pipelines, lead conversion, deal moves, activities                          | `9ddac44`            |
| Seed NumberSequence lookups           | Old unique key                          | Updated to composite `workspaceId_type_financialYear` key                                            | `7975ddf`            |
| Payment provider models               | Stripe only                             | `PaymentProvider` enum, Razorpay settings, `ProviderWebhookEvent`, `JobRun`                          | `67734a9`            |
| GST engine                            | None                                    | `packages/core/src/gst`: split-rounding engine, ≥15 golden vectors, Rule 46 validation, FY numbering | `8d3aa9a`, `3f92626` |
| CRM API                               | None                                    | `GET/POST/PATCH/DELETE /v1/leads`, `/v1/pipelines`, `/v1/deals`, bulk actions, lead conversion       | `c1366d5`            |
| Razorpay webhooks                     | Stripe only                             | `POST /webhooks/razorpay/:workspaceId` with HMAC verification and idempotency                        | `540b17f`            |
| Reports                               | None                                    | SQL views + `packages/core/src/reports` + `GET /v1/reports/*`                                        | `8404f7d`, `956ad3d` |
| Demo seed                             | None                                    | `packages/database/prisma/seed-demo.ts`: Kaveri Studio + Northlight Design                           | `abf6e74`            |
| Payment provider interface            | None                                    | `apps/api/src/payments/provider.ts` + `POST /v1/invoices/:id/payment-links`                          | `40aa75f`            |
| Deal → quote                          | None                                    | `packages/core/src/quotes` + `POST /v1/deals/:id/quote`                                              | `e9b0191`            |
| Lead import/dedupe                    | Single create                           | `POST /v1/leads/import` with email/phone upsert                                                      | `bdc4854`            |
| GST PDF template                      | None                                    | `packages/core/src/gst/pdf-template.ts` Rule 46 layout                                               | `a0ab3d5`            |
| Phase 3 closure doc                   | None                                    | Initial `docs/phase-3.md`                                                                            | `27b7f6c`            |
| Review fixes (tenant guard)           | CRM models missing workspace scoping    | Enrolled `Lead`/`Pipeline`/`Stage`/`Deal`/`DealActivity` in `WORKSPACE_SCOPED_MODELS`                | `17b263b`            |
| Review fixes (idempotency)            | Payment-links created premature Payment | `requireIdempotencyKey` middleware; pending Payment row created with link for webhook reconciliation | `201581f`            |
| Review fixes (provider errors)        | Raw Stripe/Razorpay errors leaked       | Wrapped checkout errors with `provider_error` code                                                   | `f4b5f07`            |
| Review fixes (GST)                    | Rule 46 POS mismatch, serial race       | Aligned place-of-supply validation; validate serial before incrementing sequence                     | `12ad79a`            |
| Review fixes (reports)                | Deleted deals in pipeline view          | Excluded deleted deals from `v_pipeline_stage_transitions`                                           | `9222de7`            |
| Razorpay settings UI                  | Stripe only                             | Encrypted Razorpay key/webhook secret storage, enable toggle, settings form card                     | `320d8c9`            |
| Dashboard charts                      | Revenue only                            | Receivables ageing, GST summary and pipeline summary wired to SQL views                              | `253f10b`            |
| Leads table UI                        | None                                    | `/leads` page with search, filters, row actions, bulk delete and conversion                          | `47b72b6`            |
| Deals Kanban UI                       | None                                    | `/deals` drag-and-drop board with optimistic stage moves and column totals                           | `1c9e549`            |
| Deal → quote UI                       | API only                                | One-click “Create Quote” on deal cards navigates to the quote editor                                 | `be3b141`            |
| E2E lead-to-paid flow                 | None                                    | Playwright flow test: widget lead → convert → deal → quote → payment recording                       | `a2d99f9`            |
| Review fixes (payment reconcile)      | Payment row missing from payment-link   | Pending Payment row created with provider id for webhook reconciliation                              | `d06921a`            |
| Review fixes (seed NumberSequence)    | Compound-key upsert with null failed    | Seed helpers use findFirst + id update for nullable financialYear                                    | `bea2755`            |
| Review fixes (runtime NumberSequence) | Compound-key upsert with null failed    | Atomic raw-SQL helper used by quotes/invoices/credit notes                                           | `b48f985`            |
| Review fixes (E2E selectors)          | Strict-mode violations in flow test     | Added test ids and row-action selectors; improved dialog accessibility                               | `fac4d25`            |

## Definition of done

### CRM

- Lead, pipeline, stage, deal, deal activity models and API routes exist.
- Bulk lead actions (assign, status, delete) via `POST /v1/leads/bulk`.
- Lead import with email/phone deduplication via `POST /v1/leads/import`.
- Lead conversion creates a client and deal in the default pipeline.
- Deal move records `DealActivity` and sets won/lost timestamps.
- Deal → draft quote via `POST /v1/deals/:id/quote`.

### GST

- GST computation engine with split-rounding rule and property tests.
- Rule 46 validator and FY numbering existed as functions, but at Phase 3's
  close nothing that created or issued an invoice called them, and
  `gst_unsupported` was never raised. Wired in on 2026-08-09 (see
  `docs/phase-4.md`, H7), together with a reverse-charge correction.
- FY numbering as built restarted at `INV-0001` each FY without the year
  in the number, so the first GST invoice after 1 April would have hit the
  unique key on (workspace, number). Since `76b761b` a GST number carries
  the FY: `INV/26-27/0001`. Several invoice paths (edit, duplicate,
  auto-create from a quote, recurring, legacy `/api/v1`) also bypassed the
  engine and the Rule 46 gate until the Phase 4 re-review
  (`docs/phase-4.md`, second review, items 2-3); the legacy
  `/api/v1/invoices/:id/send` endpoint, a recorded payment and a Stripe
  payment intent could still take a draft out of draft without the gate
  until the third review (`docs/phase-4.md`, third review, H1).
- GST invoice PDF template with supplier/recipient/tax breakup.
- The golden vectors were worked by hand from the rules; they were not
  reviewed by a chartered accountant (an earlier version of `golden.json`
  said they were).

### Razorpay / payments

- `PaymentProvider` interface supports Stripe Checkout and Razorpay Orders.
  As built, Stripe Checkout only worked against stripe-mock: real Stripe
  (API 2022-08-01 and later) returns no PaymentIntent on a new session and
  the code threw. Reconciled on `checkout.session.completed` since
  `dc15428`. Razorpay orders used the platform's key until `3195c0d`.
- `POST /v1/invoices/:id/payment-links` returns a provider-specific payload.
- Razorpay inbound webhook verifies HMAC-SHA256 and dedupes by `X-Razorpay-Event-Id`.
- Webhook events (`payment.captured`, `payment.failed`, `order.paid`, `refund.processed`) apply to invoices/payments.
- At Phase 3's close these lookups were not confined to the workspace that
  verified the event, so one tenant could mark another's invoice paid
  (CRITICAL, fixed 2026-08-09, `docs/phase-4.md` C1). A Razorpay payment is
  verified against a mock only; no real Razorpay test payment was made.

### Reports

- SQL views: `v_receivables_ageing`, `v_revenue_monthly`, `v_gst_outward_supplies`, `v_pipeline_stage_transitions`.
- Tenant-guarded core queries and REST routes.

### Demo seed

- Deterministic `seed-demo.ts` creates two workspaces, 40 leads, 25 deals, 30 quotes, 45 invoices, payments, 3 contracts.

## DoD evidence

| Criterion                                          | Evidence                                                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Golden vectors pass                                | `packages/core/src/gst/engine.test.ts`                                                                                                      |
| Property test `cgst + sgst == igst`                | `packages/core/src/gst/engine.test.ts`                                                                                                      |
| Razorpay webhook marks invoice paid                | Mock only: `apps/api/src/routes/v1/invoices.test.ts` (payment link → order.paid → paid). No real Razorpay test payment                      |
| Kanban keyboard DnD passes axe                     | Not met at Phase 3's close (dnd-kit defaults, no axe run). Met 2026-08-09: `e2e/product/kanban-keyboard.spec.ts`, `e2e/product/axe.spec.ts` |
| Reports read from SQL views                        | `packages/core/src/reports/index.test.ts`, `apps/api/src/routes/v1/reports.test.ts`                                                         |
| Demo seed counts match targets                     | `pnpm --filter @wolff/database seed:demo` output                                                                                            |
| Payment link creates Stripe/Razorpay session/order | `apps/api/src/routes/v1/invoices.test.ts`                                                                                                   |
| Deal → quote links deal.quoteId                    | `apps/api/src/routes/v1/crm.test.ts`                                                                                                        |
| Lead import dedupes by email                       | `apps/api/src/routes/v1/crm.test.ts`                                                                                                        |

## Test counts

Run with Postgres 17:

```bash
TEST_DATABASE_URL=postgresql://wolff:wolff_dev_only@localhost:5432/wolff?schema=public \
pnpm test
```

| Package          | Files | Tests                                  |
| ---------------- | ----- | -------------------------------------- |
| @wolff/api       | 10    | 121 passed                             |
| @wolff/core      | 17    | 200 passed                             |
| @wolff/contracts | —     | —                                      |
| @wolff/database  | 4     | 34 passed; seed-demo runs successfully |
| @wolff/jobs      | 4     | 49 passed                              |
| @wolff/web       | 72    | 1,116 passed / 7 skipped               |

Total failures: **0**.

## Build, lint, type-check, migrations

```bash
pnpm type-check   # all packages pass
pnpm lint         # all packages pass (web has pre-existing warnings)
pnpm --filter @wolff/database seed:demo
```

Migration diff against the migration history:

```bash
cd packages/database && SHADOW_DATABASE_URL="postgresql://wolff:wolff_dev_only@localhost:5432/postgres?schema=public" \
  pnpm prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema prisma/schema.prisma \
  --exit-code
```

No unapplied drift detected against the migration history.

## Review findings and fixes

A peer review of `phase2-core-api..phase3-crm-gst-razorpay` found the issues below. All CRITICAL, HIGH and MEDIUM items were fixed and re-tested.

| #   | Severity | Finding                                                                                                                                                                            | Fix                                                                                                                                                                                                                       | Evidence                                                                                                                                                                                                                                                                                                     |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | CRITICAL | Payment-link idempotency fix removed Payment-row creation, so provider webhooks found no row to reconcile and invoices were never marked paid.                                     | Payment-link route now creates a pending `Payment` row with the provider order/session id; idempotency middleware still prevents duplicates. Added integration test: `payment-link → Razorpay order.paid → invoice paid`. | `apps/api/src/routes/v1/invoices.test.ts`                                                                                                                                                                                                                                                                    |
| 2   | HIGH     | `docs/phase-3.md` commit hashes were incorrect.                                                                                                                                    | Rewrote the "What changed" table with hashes from `git log phase2-core-api..HEAD`.                                                                                                                                        | This document                                                                                                                                                                                                                                                                                                |
| 3   | HIGH     | `docs/phase-3.md` test counts were wrong.                                                                                                                                          | Updated counts to the actual values from `pnpm test` on Node 24.                                                                                                                                                          | This document                                                                                                                                                                                                                                                                                                |
| 4   | HIGH     | `docs/phase-3.md` migration-diff command used an invalid `--shadow-database-url` option.                                                                                           | Replaced with the correct `--from-migrations --to-schema --exit-code` command using `SHADOW_DATABASE_URL` env.                                                                                                            | This document                                                                                                                                                                                                                                                                                                |
| 5   | HIGH     | E2E seed failed on the composite `NumberSequence` key and used a different default email than `global-setup.ts`.                                                                   | Changed `financialYear: null as unknown as string` to `financialYear: null`; aligned default email to `test@wolff.dev`.                                                                                                   | `apps/web/e2e/utils/seed-e2e-data.ts`                                                                                                                                                                                                                                                                        |
| 6   | HIGH     | GST numbering and Rule 46 fixes had no tests that failed before the fix.                                                                                                           | Added test that `nextSerialNumber` validates serial length before incrementing the sequence, and test that intra-state B2B registered invoices do not require place of supply.                                            | `packages/core/src/gst/numbering.test.ts`, `packages/core/src/gst/rule46.test.ts`                                                                                                                                                                                                                            |
| 7   | HIGH     | Tenant-guard CRM fix was not proven by a failing test.                                                                                                                             | Added test asserting `Lead`, `Pipeline`, `Stage`, `Deal`, `DealActivity` are in `WORKSPACE_SCOPED_MODELS`.                                                                                                                | `packages/database/src/tenant-guard.test.ts`                                                                                                                                                                                                                                                                 |
| 8   | MEDIUM   | No axe/accessibility test for the Kanban board.                                                                                                                                    | Left open at Phase 3's close (a MEDIUM should not have been). Fixed 2026-08-09, see `docs/phase-4.md` M5.                                                                                                                 | This document                                                                                                                                                                                                                                                                                                |
| 9   | HIGH     | Runtime quote/invoice/credit-note numbering still used `workspaceId_type_financialYear` with `financialYear: null`, causing `Argument financialYear must not be null.` at runtime. | Added `incrementNumberSequence` in `@wolff/database` that uses a raw PostgreSQL upsert against the correct partial or full unique index; replaced all runtime compound-key upserts.                                       | `packages/database/src/number-sequence.ts`, `apps/web/lib/quotes/actions.ts`, `apps/web/lib/invoices/internal.ts`, `apps/web/app/api/v1/quotes/route.ts`, `apps/web/app/api/v1/quotes/[id]/duplicate/route.ts`, `apps/web/app/api/v1/invoices/route.ts`, `apps/web/app/api/cron/recurring-invoices/route.ts` |
| 10  | HIGH     | E2E lead-to-paid flow failed on strict-mode selectors (`Add Lead` matched two buttons, `Create Quote` matched the draggable card, invoice status not inside link).                 | Added `data-testid` to header Add Lead and Create Quote buttons; associated Source/Status selects with `aria-labelledby`; rewrote test to use test ids and row actions.                                                   | `apps/web/components/crm/leads-page-client.tsx`, `apps/web/components/crm/create-lead-dialog.tsx`, `apps/web/components/crm/deals-kanban.tsx`, `apps/web/e2e/flows/lead-to-paid.spec.ts`                                                                                                                     |

## Deviations and known issues

- **CSV lead import**: the route accepts JSON arrays. CSV parsing is a future enhancement; the dedupe logic is format-agnostic.
- **Legacy web numbering**: updated to the new `workspaceId_type_financialYear` key with a null FY cast so type-check passes. Invoice numbers in the web app now come from `packages/core` (`nextInvoiceNumber`, FY-aware); credit notes used the non-FY sequence until `829054e` (Phase 4, third review): a GST workspace now numbers them per FY, `CN/26-27/0001`.
- **Web lint warnings**: pre-existing React Compiler warnings in `apps/web` remain; they do not fail lint.
- **Live payment E2E**: the lead-to-paid Playwright flow records a manual payment. Live Stripe/Razorpay checkout and webhook reconciliation require real provider credentials and a background worker (Phase 4).
- **Razorpay client**: orders were created with the platform's env-configured Razorpay client, not with the workspace's own key. Fixed in `3195c0d` (workspace keys, `not_configured` when it has none); see `docs/phase-4.md`.
- **Test counts above** are as recorded at Phase 3's close and were not re-run; current counts are in `docs/phase-4.md`.

## What needs the repo owner

- Real Stripe test account and Razorpay test keys for end-to-end payment smoke tests.
- Review the new CRM UI routes (`/leads`, `/deals`) and dashboard cards for product/UX feedback before Phase 4 polish.
