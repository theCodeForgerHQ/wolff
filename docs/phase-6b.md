# Phase 6b: full `/api/v1` parity port

Branch `phase6b-api-parity`, from `92a7b2d` (tag `phases1-5-verified`).
Built; **not yet reviewed**. Nothing is pushed.

## Deletion date of the Next routes

The rewrite went live on the deployed demo on **2026-08-23**. The design keeps
the Next routes under `apps/web/app/api/v1` for one week as the fallback
(unset `API_V1_UPSTREAM` on wolff-web and redeploy). **Delete them on or after
2026-09-01**, together with `apps/web/lib/api/auth.ts` if nothing else uses it.

## What was built

| Item                                                                          | Where                                                                                                   | Commit                |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------- |
| Invoice email and payment receipt in the document's currency (bug found live) | `apps/web/app/api/v1/invoices/[id]/send/route.ts`, `apps/web/lib/payments/internal.ts`                  | `088f051`             |
| Invoice-from-quote moved to core, shared by web and api                       | `packages/core/src/invoices/from-quote.ts`                                                              | `98809e9`             |
| Quote-sent / invoice-sent email templates in core                             | `packages/core/src/email/templates.ts`                                                                  | `062b473`             |
| Recorded Next responses + scenario, seed, normalizer, recorder                | `apps/api/src/testing/parity/`, `scripts/record-parity.ts`, `src/routes/v1/__parity__/next-api-v1.json` | `721e9c2`             |
| The 11 route files ported to Express, behind the existing auth stack          | `apps/api/src/routes/v1/legacy/`                                                                        | `f426c81`             |
| OpenAPI for the 20 ported operations                                          | `packages/contracts/src/legacy-v1.ts`, `apps/api/src/openapi/legacy-v1.ts`                              | `cf17a20`             |
| `/api/v1/*` rewritten to the API on Vercel (`API_V1_UPSTREAM`)                | `apps/web/lib/config/api-v1-rewrite.ts`, `next.config.ts`                                               | `45989ed`             |
| Schemathesis: script, seed, CI job                                            | `apps/api/scripts/schemathesis*.{sh,ts}`, `.github/workflows/ci.yml`                                    | `cb6e93d`             |
| Fixes from a security note and from Schemathesis                              | see below                                                                                               | `3363e68` … `4a899c9` |

## Phase 6b criteria

| Criterion                                                          | State                                 | Evidence                                                                                                                                                                                                               |
| ------------------------------------------------------------------ | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Port the 11 route files to `apps/api`                              | Met                                   | All 11 files, every method (20 operations); OpenAPI test asserts each path/method                                                                                                                                      |
| Recorded-response parity, byte for byte on envelope and pagination | Met (local)                           | `parity.test.ts`: 112 of 112 recorded responses equal after normalization; 114 tests pass. Changing one error message (`'Quote not found.'`) fails 4 cases. Three recordings from `next dev` were identical            |
| Rewrite `/api/v1/*` on Vercel to the API                           | Met (deployed)                        | wolff-web has `API_V1_UPSTREAM=https://wolff-api.vercel.app`; a key-less call to `https://wolff-web.vercel.app/api/v1/clients` answers the API's envelope (`{"success":false,…}`), which the Next route never produced |
| Delete the Next routes after one week                              | Deferred, by the spec                 | Date above                                                                                                                                                                                                             |
| Schemathesis, locally and in CI                                    | Met locally; CI job not run on GitHub | `pnpm --filter @wolff/api schemathesis`: 51 operations, ~4,000 generated cases, 0 failures, exit 0 (run 3 times on the final code). The job passes `actionlint`                                                        |

### How parity is measured

`apps/api/scripts/record-parity.ts` seeds three fixed workspaces (one GST
registered), replays 112 requests on the Next app and stores status and body.
The scenario covers every route file and method: success paths, each
validation message, ids of another workspace (404), malformed JSON, the
pagination of the three lists, GST pricing and Rule 46 refusals, and the
three 401 shapes. The normalizer replaces only what differs between runs:
generated uuids and tokens (numbered by first appearance), clock timestamps,
dates relative to today (`<today+15>`), and the financial year in GST numbers.
Seed ids and 2025 dates are compared literally.

Recording command (Next dev on a scratch DB, Resend pointed at a local stub):
`RESEND_API_KEY=re_parity RESEND_BASE_URL=http://127.0.0.1:4599 NEXT_PUBLIC_APP_URL=https://app.example.test next dev -p 3101`,
then `NEXT_URL=http://127.0.0.1:3101 pnpm exec tsx scripts/record-parity.ts`.

401 responses are compared on status and the presence of `error` only: the
API answers them with the standard envelope.

## Auth, scopes and tenant scoping: old vs new, route by route


|                                         | Next route                                                                                                                                                                                               | Port                                                                                                                                                                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication                          | `authenticateApiKey` (hash lookup, revoked/expired), secret keys only                                                                                                                                    | Same function via `requireApiKey`, mounted on the `/v1` router before the legacy routes                                                                                                                                 |
| Scopes                                  | **None checked**                                                                                                                                                                                         | `clients:read/write`, `quotes:read/write`, `invoices:read/write`; from-quote needs `invoices:write` **and** `quotes:write` (it converts the quote). `scopes.test.ts`: 12 cases; dropping the from-quote scope fails one |
| Workspace                               | `auth.context.workspaceId` in every query                                                                                                                                                                | `req.ctx.workspaceId` in every query, on the tenant-guarded client (throws in test mode on an unpinned query)                                                                                                           |
| Queries that did not name the workspace | `update({ where: { id } })` ×6, line-item `deleteMany({ where: { quoteId/invoiceId } })` ×2, `invoice.findUnique({ where: { id } })` after conversion, `findFirst({ where: { quoteId } })` in conversion | All now include `workspaceId` (or `quote/invoice: { workspaceId }`)                                                                                                                                                     |
| Rate limits                             | 100/min per IP (Upstash or memory)                                                                                                                                                                       | Per key (`rateLimitPerMin`, burst 20/10 s), 30 auth failures/min per IP                                                                                                                                     |
| Email limit                             | 20/hour per workspace                                                                                                                                                                                    | 20/hour per workspace, one bucket for quotes and invoices (fixed, below)                                                                                                                                                |
| Idempotency-Key                         | Not supported                                                                                                                                                                                            | Honoured on POST (optional), as on every `/v1` POST                                                                                                                                                                     |
| Body                                    | `request.json()` after auth                                                                                                                                                                              | Read as text by the app, parsed by the route after auth, same failure rules                                                                                                                                             |

## Deviations from the recorded contract (deliberate)

1. 401, 403 (missing scope), 429 (per-key limit) and 409 (Idempotency-Key)
   use the standard envelope.
2. Inputs that made the Next routes answer **500** now get a 4xx in the
   routes' own `{ error }` shape: non-numeric `page`/`limit` (now the
   default), `recipients` not a list, a line item or `lineItems` that is not
   an object/list, a field of the wrong JSON type, a NUL character, an import
   row that is `null`, the email of a deleted client (409).
3. The 21st email of the hour answers **429** with `Retry-After: 3600`
   instead of 502 (`e6d76c1`). Nothing is sent and nothing changes, as before.
4. Unhandled errors answer the API's `{ success:false, error:{ code:
'internal_error' } }` and are reported to Sentry; the Next routes answered
   `{ error: 'Internal server error' }` or an empty 500.
5. Send-route emails go out one per recipient (the worker's transport takes
   one address) instead of one email with several `to`.

## The security note on the email limit

A commit scanner flagged a rate-limit bypass in `legacy/email.ts`. Checked
against the Next route and the middleware:

- Mounting: the legacy router is mounted on `/v1` after `requireApiKey`,
  `apiKeyRateLimit` and `idempotency`. Not bypassed; `email-limit.test.ts`
  shows a 1/min key getting 429 on a send route.
- Key: `workspaceId` only, as before (`email:<workspaceId>`); varying the
  recipients, the document id or the API key does not give a new bucket.
- **Real defect:** the quote and invoice routers each built their own sender,
  so without a shared Redis store (the API without `REDIS_URL`, and tests)
  each had its own 20/hour bucket: alternating documents sent 40/hour. The
  deployed demo uses Redis and the same key prefix, so it was not affected.
  Fixed in `3363e68`: one sender for both. The test sends 22 times from two
  keys, alternating quotes and invoices and changing recipients; the first 20
  go out, the last two do not (`[200, 200]` before the fix, `[429, 429]` now).
- The other ported routes are all on the same `/v1` router; none is mounted
  outside the limiter.

## Schemathesis findings and fixes

Schemathesis 4.29.3, `--checks not_a_server_error,status_code_conformance,content_type_conformance,response_schema_conformance`,
phases examples, coverage, fuzzing. The first run (all checks) found 16
server errors; runs 2-4 were partly against a stale server (my mistake: the
restart did not kill the old process), so the counts below come from runs on
fresh servers only.

| #   | Finding (500 unless noted)                                                                                                                                      | Area               | Fix, test-first                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | --------------------------------- |
| 1   | NaN `page`/`limit` on the 3 lists                                                                                                                               | ported (also Next) | `f9b1b4c`                         |
| 2   | `recipients` not a list; non-object line item; email of a deleted client                                                                                        | ported (also Next) | `f9b1b4c`                         |
| 3   | NUL character in any text (Postgres 22021)                                                                                                                      | all routes         | `62185b3`, legacy shape `386c7ae` |
| 4   | Plain `Error`s for caller mistakes in deals/leads (no client or lead, unknown stage, no stages)                                                                 | CRM (Phase 3)      | `a71d2fd`                         |
| 5   | Deal for an unknown client/lead, lead owner not a user: FK violations                                                                                           | CRM                | `a71d2fd`                         |
| 6   | **Tenant gap:** a user of another workspace was accepted as lead owner (create, update, bulk assign) and deal owner                                             | CRM                | `a71d2fd`, `ca52670`              |
| 7   | Bulk `status` with an unknown value; replacing stages with a foreign stage id                                                                                   | CRM                | `a71d2fd`                         |
| 8   | Stage position / deal value beyond the column (int, numeric 12,2)                                                                                               | contracts          | `a71d2fd`                         |
| 9   | `lineItems` not a list                                                                                                                                          | ported (also Next) | `386c7ae`                         |
| 10  | Two stages at one position                                                                                                                                      | contracts          | `ed69229`                         |
| 11  | A value of the wrong JSON type reaching Prisma (`clientId: {}`)                                                                                                 | ported (also Next) | `bee689b`                         |
| 12  | Second deal on a lead; removing a stage that holds deals                                                                                                        | CRM                | `5992251`                         |
| 13  | `clients: [null]` in import                                                                                                                                     | ported (also Next) | `58cc043`                         |
| 14  | 502 when the hourly email limit is reached                                                                                                                      | ported             | `e6d76c1` (429)                   |
| 15  | Lead conversion when a client has the email / the lead has a deal; deal owner on update                                                                         | CRM                | `ca52670`                         |
| 16  | Undocumented codes (cursor 400s, deal 404/409, stages 409, convert 409/422, list 400s) and `expectedCloseDate` documented as a date but returned as a timestamp | docs               | `ebda532`, `365101a`, `4a899c9`   |

Not checked in CI, with reasons in `scripts/schemathesis.sh`: positive/negative
data acceptance (the ported routes validate by hand; their request schemas are
loose on purpose), unsupported methods (Express answers 404, not 405), and the
stateful phase (no OpenAPI links). One unique-violation 500 on lead create was
logged once and not reproduced (case-insensitive duplicate email answers 409);
it is left as a known issue.

## Checks at the tip

Run on 2026-08-23 at `4b78440` in a fresh `git worktree` (only the committed
`.env.example` files, no `.env`), Node 24.21.0, Postgres 17 + pgvector,
stripe-mock 0.205.0, Redis 7; one fresh database per suite, suites one at a
time (script `/tmp/p6b-checks.sh`, outside the repo).

| Check                                                          | Result                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`, `db:generate`                | ok                                                                                                                                                                                                                                                                                                    |
| `pnpm type-check --force`                                      | 14/14 tasks                                                                                                                                                                                                                                                                                           |
| `pnpm lint --force`                                            | 14/14 tasks, 0 errors                                                                                                                                                                                                                                                                                 |
| `prisma migrate deploy` + `db:migrate:check`, fresh DB         | ok, no difference                                                                                                                                                                                                                                                                                     |
| core / jobs / database / contracts                             | 288 / 77 (1 skipped) / 39 / 18 passed                                                                                                                                                                                                                                                                 |
| api / widget / web                                             | 381 / 12 / 1246 passed                                                                                                                                                                                                                                                                                |
| ruff, ruff format, mypy (strict)                               | clean                                                                                                                                                                                                                                                                                                 |
| pytest (fresh DB: Prisma, bootstrap, Alembic)                  | 233 passed, 1 skipped (eval test, needs its own DB)                                                                                                                                                                                                                                                   |
| `pnpm build --force`                                           | 4/4 tasks                                                                                                                                                                                                                                                                                             |
| `openapi:gen` + `git diff --exit-code`                         | no diff                                                                                                                                                                                                                                                                                               |
| E2E flows: setup, flows, product projects, CI=1, `--retries=0` | 18 passed, 1 failed: `automation.spec.ts` "reorders steps with the keyboard" (pre-existing flake, below). The `widget` project (2 specs) was not run: port 5173, hard-coded in the config and the seeded key's allowed origin, was held by an unrelated dev server of the owner's that I did not stop |
| E2E assistant, CI=1, `--retries=0`                             | 2 passed                                                                                                                                                                                                                                                                                              |
| Schemathesis script                                            | 0 failures, exit 0                                                                                                                                                                                                                                                                                    |

Not run: visual regression (no page changed), the AI image build, GitHub
Actions itself.

## Verified on the deployed demo (2026-08-23)

Deployed wolff-api and wolff-web from `git archive` of `4b78440`.
`/readyz` ready; `/openapi.json` lists the ported paths.

- One call per ported route file, through `https://wolff-web.vercel.app/api/v1`
  (the rewrite), with a Kaveri key holding the backfill scope set: clients
  list 200 (pagination present), create 201, get/patch 200, import 201;
  quotes list 200, create 201, get/patch 200, duplicate 201, send 200;
  from-quote 201 (`INV/26-27/0003`); invoices list 200, create 201, get/patch
  200, send 200; deletes 200. The test rows were deleted afterwards.
- The invoice email arrived: subject "Invoice INV-KS-032 from Kaveri Studio -
  ₹13,378.84" (himalaya, read-only). It and the quote email were in Gmail's
  Spam folder, not the inbox.

## Known issues

- **Flaky E2E, pre-existing:** `apps/web/e2e/product/automation.spec.ts:43`
  (keyboard reorder: an ArrowUp after pick-up is sometimes not announced).
  Measured with `--repeat-each`: 1 of 5 runs failed at this tip, **5 of 10 at
  the base `92a7b2d`**, so it predates this phase. Not fixed here (Phase 4
  code; deciding whether the key press is lost in the app or only in the test
  needs a proper look). Phase 7 or the Phase 4 owner.

- The existing demo key `DEMO_KAVERI_SECRET_API_KEY` was created with a
  narrow scope set; the Next routes ignored scopes, the API does not, so that
  key now gets 403 on clients and quotes. Correct by the design, but any real
  key created with narrow scopes changes behaviour at the rewrite.
- Mid-history commit `58cc043` adds its fix without its test (the null-row
  case landed in the next commit's test file).
- Phase 6 (operations) is not closed; this phase started from
  `phases1-5-verified` as instructed.

## Needs the owner

- Decide whether keys with narrow scopes should be widened before the Next
  routes are deleted (see above).
- Delete the Next routes on or after 2026-09-01.
- Demo emails land in Gmail Spam (Resend's shared `onboarding@resend.dev`
  sender); a verified sending domain fixes it.
- UptimeRobot reported wolff-ai DOWN at 16:33 UTC (not touched in this phase).
- A new demo key, `DEMO_KAVERI_V1_API_KEY`, was added to secrets.env (Kaveri
  Studio, backfill scopes).
