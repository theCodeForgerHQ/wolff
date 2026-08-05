# Phase 3: CRM + GST + Razorpay + demo seed

Branch `phase3-crm-gst-razorpay`, on top of `phase2-core-api`.
Phase 3 has a task list and a definition of done.

## What changed

| Area                       | Before                                   | After                                                                                                | Commit               |
| -------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------- |
| CRM models                 | None                                     | `Lead`, `Pipeline`, `Stage`, `Deal`, `DealActivity` with migrations                                  | `32712ea`            |
| GST models/fields          | None                                     | GST fields on invoices, line items, clients, business profiles; GST enums                            | `ff2a7a9`            |
| Payment provider models    | Stripe only                              | `PaymentProvider` enum, Razorpay settings, `ProviderWebhookEvent`, `JobRun`                          | `9290530`            |
| CRM core                   | None                                     | `packages/core/src/crm`: pipelines, lead conversion, deal moves, activities                          | `11899e8`            |
| GST engine                 | None                                     | `packages/core/src/gst`: split-rounding engine, ≥15 golden vectors, Rule 46 validation, FY numbering | `5abe8af`, `245992a` |
| CRM API                    | None                                     | `GET/POST/PATCH/DELETE /v1/leads`, `/v1/pipelines`, `/v1/deals`, bulk actions, lead conversion       | `0fe4c43`            |
| Razorpay webhooks          | Stripe only                              | `POST /webhooks/razorpay/:workspaceId` with HMAC verification and idempotency                        | `ffeba62`            |
| Reports                    | None                                     | SQL views + `packages/core/src/reports` + `GET /v1/reports/*`                                        | `95787cc`, `7f288d4` |
| Demo seed                  | None                                     | `packages/database/prisma/seed-demo.ts`: Kaveri Studio + Northlight Design                           | `d30506f`            |
| Payment provider interface | None                                     | `apps/api/src/payments/provider.ts` + `POST /v1/invoices/:id/payment-links`                          | `19fd8e9`            |
| Deal → quote               | None                                     | `packages/core/src/quotes` + `POST /v1/deals/:id/quote`                                              | `5c0c781`            |
| Lead import/dedupe         | Single create                            | `POST /v1/leads/import` with email/phone upsert                                                      | `c23ca0d`            |
| GST PDF template           | None                                     | `packages/core/src/gst/pdf-template.ts` Rule 46 layout                                               | `1be89c0`            |
| Web type-check             | Broken on `NumberSequence` composite key | Legacy web call sites updated to `workspaceId_type_financialYear`                                    | `77bdbc3`            |

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
- Rule 46 validation on invoice numbers.
- Financial-year-aware serial numbering via `NumberSequence` composite key.
- GST invoice PDF template with supplier/recipient/tax breakup; rejects composition and cess.

### Razorpay / payments

- `PaymentProvider` interface supports Stripe Checkout and Razorpay Orders.
- `POST /v1/invoices/:id/payment-links` returns a provider-specific payload.
- Razorpay inbound webhook verifies HMAC-SHA256 and dedupes by `X-Razorpay-Event-Id`.
- Webhook events (`payment.captured`, `payment.failed`, `order.paid`, `refund.processed`) apply to invoices/payments.

### Reports

- SQL views: `v_receivables_ageing`, `v_revenue_monthly`, `v_gst_outward_supplies`, `v_pipeline_stage_transitions`.
- Tenant-guarded core queries and REST routes.

### Demo seed

- Deterministic `seed-demo.ts` creates two workspaces, 40 leads, 25 deals, 30 quotes, 45 invoices, payments, 3 contracts.

## DoD evidence

| Criterion                                          | Evidence                                                                            |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Golden vectors pass                                | `packages/core/src/gst/engine.test.ts`                                              |
| Property test `cgst + sgst == igst`                | `packages/core/src/gst/engine.test.ts`                                              |
| Razorpay webhook marks invoice paid                | `apps/api/src/webhooks/webhooks.test.ts`                                            |
| Reports read from SQL views                        | `packages/core/src/reports/index.test.ts`, `apps/api/src/routes/v1/reports.test.ts` |
| Demo seed counts match targets                     | `pnpm --filter @wolff/database seed:demo` output                                    |
| Payment link creates Stripe/Razorpay session/order | `apps/api/src/routes/v1/invoices.test.ts`                                           |
| Deal → quote links deal.quoteId                    | `apps/api/src/routes/v1/crm.test.ts`                                                |
| Lead import dedupes by email                       | `apps/api/src/routes/v1/crm.test.ts`                                                |

## Test counts

Run with Postgres 17:

```bash
TEST_DATABASE_URL=postgresql://wolff:wolff_dev_only@localhost:5432/wolff?schema=public \
pnpm test
```

| Package          | Files | Tests                       |
| ---------------- | ----- | --------------------------- |
| @wolff/api       | 10    | 119 passed                  |
| @wolff/core      | 9     | 120 passed                  |
| @wolff/contracts | —     | —                           |
| @wolff/database  | —     | seed-demo runs successfully |
| @wolff/jobs      | —     | (Phase 2 baseline)          |
| @wolff/web       | —     | type-check + build pass     |

Total API/core failures: **0**.

## Build, lint, type-check, migrations

```bash
pnpm type-check   # all packages pass
pnpm lint         # all packages pass (web has pre-existing warnings)
pnpm --filter @wolff/database seed:demo
```

Migration diff on a fresh database:

```bash
cd packages/database && pnpm prisma migrate diff \
  --from-empty --to-schema prisma/schema.prisma \
  --shadow-database-url "postgresql://wolff:wolff_dev_only@localhost:5432/postgres?schema=public"
```

No unapplied drift detected against the migration history.

## Deviations and known issues

- **Kanban UI, leads table UI, Razorpay settings UI, dashboard charts**: not built in this phase. The API and core pieces they need are complete; UI is deferred to Phase 4 (frontend) and the v0.5 milestone.
- **E2E lead → paid flow**: not recorded. The individual API pieces (lead import, conversion, deal → quote, payment links, Razorpay webhook) are tested in unit/integration tests.
- **CSV lead import**: the route accepts JSON arrays. CSV parsing is a future enhancement; the dedupe logic is format-agnostic.
- **Legacy web numbering**: updated to the new `workspaceId_type_financialYear` key with a null FY cast so type-check passes. It remains non-GST-aware; GST workspaces should use the new API or `packages/core/gst/numbering`.
- **Web lint warnings**: pre-existing React Compiler warnings in `apps/web` remain; they do not fail lint.

## What needs the repo owner

- Real Stripe test account and Razorpay test keys for end-to-end payment smoke tests.
- Decision on whether to build the Kanban/leads-table UI in Phase 4 or defer further.
