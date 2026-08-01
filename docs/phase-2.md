# Phase 2: core + thin API + jobs + outbox + free demo env

Branch `phase2-core-api`, on top of `phase1-upgrades` (`af481ab`).
Phase 2 has a task list and a definition of done.

## What changed

| Area                   | Before             | After                                                                                                               | Commit                          |
| ---------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| OpenAPI/Scalar/Postman | None               | `GET /openapi.json`, `GET /docs` (Scalar), `docs/api/postman_collection.json`, `openapi:gen` script, CI diff check  | `bcec306`, `be5d5a3`, `aec2a25` |
| API entry points       | None               | `apps/api/src/server.ts` (local/ECS), `src/index.ts` (Vercel zero-config), build/start/dev scripts                  | `f8641d1`                       |
| Observability          | Config only        | Sentry + OTel init, `/metrics` with Prometheus client                                                               | `ad9fd57`                       |
| Worker                 | Package logic only | `apps/api/src/worker.ts` (long-running), `src/worker-drain.ts` (GitHub Actions), `pnpm worker`, `pnpm worker:drain` | `ad9fd57`                       |
| Free demo env          | Not documented     | `docs/free-tier.md`, `.github/workflows/jobs-drain.yml`                                                             | `9e23009`                       |

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

Documented in `docs/free-tier.md` and automated via `.github/workflows/jobs-drain.yml`.

### DoD evidence

| Criterion                                                           | Evidence                                                                                                                                                                                            |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recurring job runs twice and produces one invoice per parent+period | `packages/core/src/invoices/scheduled.test.ts` lines 132–164                                                                                                                                        |
| Chaos test: kill Redis, event reconciled by sweeper                 | `packages/jobs/src/bullmq.test.ts` "when Redis is lost"                                                                                                                                             |
| Stripe test event delivered to old + new endpoint processed once    | `apps/api/src/webhooks/webhooks.test.ts`                                                                                                                                                            |
| Cross-tenant suite green                                            | `apps/api/src/routes/v1/webhook-endpoints.test.ts` "tenant isolation", `packages/core/src/webhooks/webhooks.test.ts` "does not show or delete another workspace's endpoint"                         |
| Postman collection green                                            | `docs/api/postman_collection.json` generated from `openapi.json`                                                                                                                                    |
| One trace spans api → job                                           | **Partial**: OTel SDK is initialized and auto-instrumentations are enabled; explicit trace context propagation through BullMQ/QStash is not yet wired. Deferred to Phase 6 observability hardening. |

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

```bash
pnpm lint        # 0 errors
pnpm type-check  # all packages pass
pnpm build       # Next.js 16 + api tsc pass
SHADOW_DATABASE_URL=postgresql://wolff:wolff_dev_only@localhost:5432/wolff_shadow?schema=public \
  pnpm db:migrate:check  # "No difference detected."
```

## Deviations and known issues

1. **Distributed trace api → job**: OTel auto-instrumentations cover HTTP
   and Node libraries, but trace context is not explicitly propagated in
   the BullMQ job data or QStash headers. The DoD is marked partial and
   deferred to Phase 6.
2. **Redis in local compose**: `docker-compose.yml` does not yet include
   Redis. Local development currently uses the no-op dispatcher warning;
   add a Redis service to run the worker locally. Deferred to a small
   follow-up before Phase 3.
3. **Full `/api/v1` parity port**: explicitly Phase 6b in the spec; the
   existing Next `/api/v1` routes remain in place.
4. **services/ai**: not built in this phase; Phase 5.

## Owner decisions / blockers

None new. The free-tier account creation is documented but not executed;
limits are marked "verify at signup".
