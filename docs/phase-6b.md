# Phase 6b: full `/api/v1` parity port

Branch `phase6b-api-parity`, from `92a7b2d` (tag `phases1-5-verified`).
Built, reviewed by the other developer and fixed; see "Review findings and
fixes" at the end. Pre-fix tip tagged `phase6b-pre-review-fixes` (`aba8d44`). Nothing
is pushed.

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
| `/api/v1/*` rewritten to the API on Vercel (`API_V1_UPSTREAM`)                | `apps/web/lib/config/api-v1-rewrite.ts`, `proxy.ts` (was `next.config.ts`)                              | `45989ed`, `9685fa7`  |
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


|                                         | Next route                                                                                                                                                                                               | Port                                                                                                                                                                                                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication                          | `authenticateApiKey` (hash lookup, revoked/expired), secret keys only                                                                                                                                    | Same function via `requireApiKey`, mounted on the `/v1` router before the legacy routes                                                                                                                                                                                          |
| Scopes                                  | **None checked**                                                                                                                                                                                         | `clients:read/write`, `quotes:read/write`, `invoices:read/write`; from-quote needs `invoices:write` **and** `quotes:write` (it converts the quote). `scopes.test.ts`: each of the 20 operations with a key holding every other scope; removing any one of the 22 checks fails it |
| Workspace                               | `auth.context.workspaceId` in every query                                                                                                                                                                | `req.ctx.workspaceId` in every query, on the tenant-guarded client (throws in test mode on an unpinned query)                                                                                                                                                                    |
| Queries that did not name the workspace | `update({ where: { id } })` ×6, line-item `deleteMany({ where: { quoteId/invoiceId } })` ×2, `invoice.findUnique({ where: { id } })` after conversion, `findFirst({ where: { quoteId } })` in conversion | All now include `workspaceId` (or `quote/invoice: { workspaceId }`)                                                                                                                                                                                                              |
| Rate limits                             | 100/min per IP (Upstash or memory)                                                                                                                                                                       | Per key (`rateLimitPerMin`, burst 20/10 s), 30 auth failures/min per caller IP; Vercel's edge sets the caller's IP directly and through the rewrite (checked live)                                                                                                   |
| Email limit                             | 20/hour per workspace                                                                                                                                                                                    | 20/hour per workspace, one bucket for quotes and invoices (fixed, below)                                                                                                                                                                                                         |
| Idempotency-Key                         | Not supported                                                                                                                                                                                            | Honoured on POST (optional), as on every `/v1` POST                                                                                                                                                                                                                              |
| Body                                    | `request.json()` after auth                                                                                                                                                                              | Read as text by the app, parsed by the route after auth, same failure rules                                                                                                                                                                                                      |

## Deviations from the recorded contract (deliberate)

1. 401, 403 (missing scope), 429 (per-key limit) and 409 (Idempotency-Key)
   use the standard envelope.
2. Inputs that made the Next routes answer **500** now get a 4xx in the
   routes' own `{ error }` shape: non-numeric `page`/`limit` (now the
   default), `recipients` not a list, a line item or `lineItems` that is not
   an object/list, a field of the wrong JSON type (named: "clientId must be
   a string"), a NUL character, an import row that is `null` or has a
   non-string email or phone (a row error), the email of a deleted client
   (409).
3. The 21st email of the hour answers **429** instead of 502 (`e6d76c1`),
   with `Retry-After` set to the seconds left in the workspace's window
   (`83060f0`). Nothing is sent and nothing changes, as before.
4. Unhandled errors answer the API's `{ success:false, error:{ code:
'internal_error' } }` and are reported to Sentry; the Next routes answered
   `{ error: 'Internal server error' }` or an empty 500.
5. Send-route emails go out one per recipient (the worker's transport takes
   one address) instead of one email with several `to`. Each recipient has
   its own idempotency key per document version and email content, so a
   retry after a partial failure does not email the recipients who already
   got it (`1a72ddb`).
6. A request without a key gets 401 whatever its body holds; the NUL check
   runs after authentication (`3b7557c`).

## Breaking change: scopes are now enforced

The Next routes checked only that a key was valid. The port requires the
scope of each operation (table above). **A key created with a
narrow scope set now gets 403 on the operations its scopes do not cover**,
through the rewrite as well as directly; before the rewrite, the same key
could call every route. Keys created before scopes existed were backfilled
with every scope but `webhooks:manage`, so they are unaffected. The check is
not loosened (owner decision, 2026-08-23). The demo key
`DEMO_KAVERI_SECRET_API_KEY`, which had 8 scopes and so got 403 on clients
and quotes, was widened on Neon to all 17 scopes. The seed
creates no API keys (it deletes Kaveri's on a reseed), so there is no seed
change. Clients holding narrow keys need new keys or wider scopes before the
Next routes are deleted.

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
stateful phase (no OpenAPI links). Instead of links, the seed creates fixed
fixtures and writes a config that pins every `{id}` operation to one
(`9f5382c`); see "Review findings and fixes". One unique-violation 500 on lead create was
logged once and not reproduced (case-insensitive duplicate email answers 409);
it is left as a known issue.

## Checks at the build tip (before the review)

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

## Verified on the deployed demo at the build tip (2026-08-23)

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

- Six private `/v1` POST operations accept an optional Idempotency-Key and
  can answer 409 like the others, but do not list 409 in the OpenAPI
  document: `/webhook-endpoints/{id}/test`, `/webhook-deliveries/{id}/retry`,
  `/leads/bulk`, `/leads/import`, `/pipelines`, `/deals/{id}/move`.
- Payment links answer `501 not_configured` for a workspace without payment
  settings (documented in docs/API.md and the OpenAPI document). A 5xx for a
  configuration state is unusual; changing a public status code was out of
  scope for the review fixes. Schemathesis is told to expect it.
- Item 6 (no second email on a retried send) is verified with tests and with
  Resend's own key handling live (below); a partial provider failure cannot
  be forced on the deployed demo.
- The FinancialHealthSection and SalesPipelineSection components are not
  rendered by any page; they were fixed because they are exported.
- One unique-violation 500 on lead create was logged once during the build's
  Schemathesis runs and not reproduced since.
- Phase 6 (operations) is not closed; this phase started from
  `phases1-5-verified` as instructed.

### History cleanup list (not rewritten; needs the owner's approval)

- `58cc043` "fix(api): fail an import row that is not an object instead of
  answering 500": its body cites a test that landed in the next commit,
  `e6d76c1`, so `58cc043` has the fix without its test.

## Needs the owner

- Delete the Next routes on or after 2026-09-01.
- Clients with narrow keys get 403 where the Next routes let them through
  (breaking change above): issue wider keys before the Next routes go.
- Approve (or not) rewording/squashing the commit in the history cleanup list.
- Demo emails land in Gmail Spam or Inbox inconsistently (Resend's shared
  `onboarding@resend.dev` sender); a verified sending domain fixes it.
- Decide whether payment links should keep 501 for "not configured".

## Review findings and fixes

One peer review of `92a7b2d..aba8d44`. Each finding was checked
against the code before fixing; fixes are one commit each, test first, and
each test was seen failing on the code before the fix (guard reverts in a
/tmp copy).

| #   | Finding                                                               | Verdict                                                                                                                                                                                                                                                                      | Fix                              |
| --- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 1   | Scope tests missed routes                                             | Confirmed: 10 of 20 operations had no 403 case                                                                                                                                                                                                                               | `54328c5`; 22 of 22 mutants fail |
| 2   | Every PrismaClientValidationError mapped to 400                       | Confirmed. Types are checked per route (22 cases); the mapping is gone; a coordinator follow-up: Prisma messages carry query values, so reports and logs get only class, code and model.operation, and Sentry events drop bodies, cookies, query strings and headers         | `53e1070`, `087fbf6`, `611473c`  |
| 3   | Per-IP auth-failure limit behind the rewrite might key on a Vercel IP | **Not a defect.** Live, 2026-08-23 and 2026-08-30: the API's request log shows `X-Forwarded-For` = the caller's own IP both directly and through the rewrite, and a forged value is replaced, so `req.ip` (`trust proxy 1`) is the caller's. Test pins the per-caller keying | `eab7d45` (test only)            |
| 4   | `58cc043` claims a test from `e6d76c1`                                | Confirmed; recorded above, not rewritten                                                                                                                                                                                                                                     | this doc                         |
| 5   | Retry-After fixed at 3600                                             | Confirmed                                                                                                                                                                                                                                                                    | `83060f0`                        |
| 6   | Partial sends re-email earlier recipients on retry                    | Confirmed (random attempt id in the key)                                                                                                                                                                                                                                     | `1a72ddb`                        |
| 7   | NUL check before the key check                                        | Confirmed (400 before 401)                                                                                                                                                                                                                                                   | `3b7557c`                        |
| 8   | Import: array email → 500                                             | Confirmed; it failed even earlier than reported (the duplicate lookup passed the array to Prisma). Numeric phone failed the whole batch                                                                                                                                      | `22d45f4`                        |
| 9   | USD hard-coded on the dashboard                                       | Confirmed for the editor line; the two analytics sections take the base currency the totals are converted to and label it                                                                                                                                                    | `5c96a76`, `1e28232`             |
| 10  | Session cookie forwarded to the API                                   | Confirmed live (the API's log showed a cookie). Stripping is possible in the proxy, so the rewrite moved there                                                                                                                                                               | `9685fa7`                        |
| 11  | Schemathesis mostly 404 on `{id}` paths                               | Confirmed: 20 of 30 `{id}` operations reached a 2xx, 39% of their requests 404. Now 28 of 30, 7%. The run found two real OpenAPI gaps                                                                                                                                        | `9f5382c`, `4e9f317`, `dd693ee`  |
| 12  | Demo key 403 on clients and quotes                                    | Widened on Neon (8 → 17 scopes); breaking change documented above                                                                                                                                                                                                            | data + this doc                  |
| 13  | Flaky keyboard E2E                                                    | Root cause in the test: dnd-kit adds its keydown listener in a `setTimeout` after pick-up; traced in the page, the arrow key arrived first in 8 of 8 failures. Tests now wait for that timer                                                                                 | `f8d2d1d`; widget port `004928a` |

### Checks at the fixed tip `9f5382c`

Clean `git worktree` (only `.env.example` files), Node 24.21.0, Postgres 17,
stripe-mock, Redis; a fresh database per suite, suites one at a time.

| Check                                       | Result                                |
| ------------------------------------------- | ------------------------------------- |
| install (frozen lockfile), `db:generate`    | ok                                    |
| type-check / lint (`--force`)               | pass / pass, 0 errors                 |
| `migrate deploy` + `db:migrate:check`       | ok, no difference                     |
| core / jobs / database / contracts          | 288 / 77 (1 skipped) / 39 / 18 passed |
| api / widget / web                          | 425 / 12 / 1251 passed                |
| ruff, ruff format, mypy                     | clean                                 |
| pytest (Alembic, bootstrap)                 | 233 passed, 1 skipped                 |
| build                                       | pass                                  |
| openapi:gen + diff                          | no diff                               |
| parity suite                                | 114 passed (112 recordings)           |
| Schemathesis                                | 3,684 cases, 0 failures               |
| E2E flows + setup + product + widget (5180) | 21 passed, CI=1, retries 0            |
| E2E assistant                               | 2 passed, CI=1, retries 0             |
| E2E visual (7 tests x 3 widths, darwin)     | 21 passed, CI=1, retries 0            |
| Keyboard tests, 10 consecutive runs         | 10 of 10 passed, CI=1, retries 0      |

The E2E rows were run on 2026-08-30 at `9f5382c` in the clean worktree, after
a production build with `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_wolffE2E`,
on fresh migrated and seeded databases (one per config), widget preview on
:5180. Keyboard runs: `--project setup --project product -g keyboard`, ten
runs in a row, each waiting until :3200, :5180 and :9099 were free; each run
was 3 passed (sign-in setup, the Kanban move, the automation reorder), 0
failed. An earlier attempt at this count is void: 8 of its 10 runs never
started because the previous run's servers still held :5180.

### Live, after redeploying api and web from `git archive` of `9f5382c` (2026-08-30)

Redeployed with `vercel deploy --prod` from a `git archive` copy (no `.env`
files): api `wolff-5g02finew`, web `wolff-okm5u6e7u`. Checked at 00:25-00:30 UTC.

- `/readyz` 200.
- Item 12: `DEMO_KAVERI_SECRET_API_KEY` through the web's `/api/v1` rewrite:
  clients, quotes and invoices all 200 (clients and quotes were 403).
- Item 3: one direct call and one rewritten call, each with a forged
  `X-Forwarded-For: 9.9.9.9`: the API's request log shows the caller's own
  address (the one `api.ipify.org` reports) for both, never Vercel's or the
  forged one.
- Item 10: the rewritten call carried a `Cookie` header; the API's log line
  for it has no cookie.
- Item 6, partly: two concurrent identical `POST /invoices/{id}/send` through
  the rewrite (one recipient) both answered 200 and delivered two emails.
  This is not the retry the fix covers: the second request read the invoice
  after the first had marked it sent (two `sent` events 143 ms apart), so it
  was a new version and a new key, which the design sends on purpose. Had
  both read the same version, Resend would have refused the second with 409
  `concurrent_idempotent_requests` (checked directly: same key, two
  concurrent calls, one 200 and one 409, one email). A retry after a partial
  failure cannot be forced on the live provider; it is covered by the test in
  `1a72ddb` (mock only) and by the earlier sequential same-key check against
  Resend (two sends, one email).
- Known issue, LOW: in that same-version race the second request answers 502
  "could not be sent" although the email did go out once. Not fixed in this
  phase; recorded for Phase 7.
