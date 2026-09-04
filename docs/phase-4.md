# Phase 4: Frontend: RTK, widget, automation builder

Branch `phase4-rtk-widget-automation`. **Phase 4 is closed** for everything that can be done without the owner's accounts, and the
v0.5 milestone (README v0.5, live demo, video, tag `v0.5.0`) is **not done**:
nothing is deployed and no tag was made.

The Phase 4 build (up to `27c817d`) was reviewed twice, together with
Phases 2 and 3, and the fixed branch (tip `e8daf1a`, tagged
`phase4-pre-rereview-fixes`) was reviewed again. A third, narrow review of
`31e4eeb` followed. The second half of this document lists every finding
and what happened to it. Hashes in the first review table are from before
the history cleanup; hashes in the later tables are current.

## State of the Phase 4 criteria

| Criterion                                                             | State                   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RTK store per request/mount, slices, redux-undo, listener persistence | Met                     | `apps/web/lib/store`; no module-level store (guard test in `__tests__/lib/store/quote-builder-rtk.test.tsx`)                                                                                                                                                                                                                                                                                                         |
| Undo/redo across 100 edits                                            | Met                     | Same test file: 100 edits undone to the initial document and redone. `limit` is 101 (redux-undo counts the present state); the design says `limit: 100`                                                                                                                                                                                                                                                               |
| SSR isolation (two concurrent requests get distinct stores)           | Met, weakly proven      | 20 interleaved `renderToString` renders each show only their own document. This test also passes with the old singleton; the guard against a module-level store is what fails on it                                                                                                                                                                                                                                  |
| Widget lead-form, invoice-pay, quote-link; publishable keys           | Met (mock providers)    | `apps/widget`, `apps/api/src/routes/v1/public.ts`; keys created in Settings → API with allowed origins                                                                                                                                                                                                                                                                                                               |
| Widget ≤ 60 kB gzip                                                   | Met                     | size-limit: 10.8 kB (IIFE) / 10.7 kB (ES); runs in CI's build job                                                                                                                                                                                                                                                                                                                                                    |
| Widget interactive ≤ 300 ms after DOMContentLoaded, throttled         | Met locally             | `e2e/widget/perf.spec.ts`: Fast 3G + 4x CPU, the widget's own performance mark                                                                                                                                                                                                                                                                                                                                       |
| SRI hash per release                                                  | Met (build output)      | `dist/sri.json` written by `apps/widget/scripts/sri.mjs`; not published anywhere (no CDN)                                                                                                                                                                                                                                                                                                                            |
| Rejected from a non-allowed origin                                    | Met                     | `apps/api/src/routes/v1/public.test.ts` (exact Origin, empty list denies, no Referer)                                                                                                                                                                                                                                                                                                                                |
| Automation run pauses at approval and resumes on approve (E2E)        | Met                     | `e2e/product/automation-approval.spec.ts`; resuming in the worker is covered by `packages/jobs/src/jobs.test.ts`. The pause notifies approvers in the app (`0aa4935`); no email                                                                                                                                                                                                                                      |
| axe clean on builder, Kanban, widget, automations                     | Met                     | `e2e/product/axe.spec.ts`, `e2e/widget/axe.spec.ts`                                                                                                                                                                                                                                                                                                                                                                  |
| CSP tightening                                                        | Met                     | `apps/web/lib/security/csp.ts`, `e2e/flows/csp.spec.ts`; 27 pages opened in Chromium with no violation after `e4afd9b` (pay dialog not opened)                                                                                                                                                                                                                                                                       |
| web-vitals reporting                                                  | Met, field data pending | `components/web-vitals/reporter.tsx` sends every vital to `/api/vitals`, which logs it with its Core Web Vitals rating (`0db7abb`, `2226315`); `lib/observability/web-vitals.ts` turns samples into p75 rows and a README table (`d7e54a6`). With a DSN set, Sentry's browser tracing records LCP/CLS/INP on page-load spans. The README p75 table needs field data from the deployed demo, which does not exist yet |

## Deviations and decisions

- Approvals are decided only by a signed-in member whose role ranks at
  least the step's role; API keys get 403. The design says approvals happen
  "in the app"; the API approve/reject routes stay and answer 403.
- An automation without an approval step may send email without a person
  in the loop. That is what the design describes (the first reminder is
  automatic), so the review's suggestion to require one was not adopted.
- GST: signature on an electronic invoice is treated as not required
  (Rule 46(q) proviso), and goods lines cannot pass Rule 46 because no
  unit is stored. Both are for the owner's CA to confirm.
- The invoice editor has no HSN/SAC field yet; GST invoices get HSN from
  quotes (deal → quote) or the server action's input, and an edited line
  keeps the HSN of the stored line it edits. The legacy `/api/v1` invoice
  routes price GST and gate issuing since `6c59013`; their port to
  `apps/api` stays in Phase 6b.
- GST numbers carry the financial year (`INV/26-27/0001`, 14 characters).
  Since `f2a6e5a` credit notes in a GST workspace are numbered the same way
  (`CN/26-27/0001`); other workspaces keep `CN-0001`. The design does not
  say how credit notes are numbered; this follows Rule 46(b)'s serial per
  FY and is for the owner's CA to confirm.
- A GST invoice gets its number when the draft is created, in the FY of
  its `issueDate`, which is set to the creation date and not changed when
  the invoice is issued. Number and printed date therefore always agree,
  but a draft created on 31 March and sent on 2 April is dated and
  numbered in the earlier FY. Numbering at issue was not done: it needs a
  nullable `invoiceNumber` (a migration, and every list, PDF, search and
  API response that shows a draft's number) and a rule for re-dating the
  invoice; Rule 46 also asks for consecutive serials, so renumbering at
  issue could not leave gaps. Credit notes have the same property. For the
  owner's CA to decide.
- A recurring GST series whose next copy cannot be priced (no supplier
  state code and no client state, a composition supplier, an invoice-level
  discount) is paused: `nextRecurringDate` is cleared, a
  `recurring_paused` event on the parent says why, and each workspace
  owner gets an in-app notification. Saving the recurring settings again
  resumes it. A client without a state code alone does not pause it:
  pricing falls back to the supplier's state (`priceGstInvoice`).
- A Stripe Checkout Session is credited only if its `amount_total` and
  currency equal the pending payment; otherwise it is not linked to its
  PaymentIntent and a `payment_mismatch` event is recorded on the invoice.
  `checkout.session.expired` and `checkout.session.async_payment_failed`
  mark the pending payment failed. Mock and recorded-shape tests only.
- An auto-created or auto-sent GST invoice that fails Rule 46 stays a
  draft with an `auto_send_blocked` event; the portal does not show it to
  the client. The design does not say what should happen; this is the
  conservative reading.
- Automation create/update/delete need the owner or admin role (same rule
  as API keys); the design does not name a role.
- Publishable keys: per-key minute and burst limits apply; the design's
  per-IP 20/min on `/public/leads` is not implemented.

## Known issues and deferred

- The approval step notifies in the app only; no email (core has no
  direct email port, only templated scheduled emails).
- Stripe Checkout and Razorpay are verified against mocks and recorded
  event shapes only; the Checkout change follows Stripe's 2022-08-01
  changelog, not a live test-mode session.
- An expired or stale session whose user no longer exists renders the
  "Something went wrong" page instead of redirecting to sign-in (seen when
  re-seeding the visual database; the suite now re-signs in).
- `/api/cron/reset-demo` stays (no `demo.reset` job yet). PDF smoke test,
  uptime check, Neon `bootstrap.sql`, the three Vercel projects: deferred
  with the demo environment (Phase 6).
- One trace api → job: not wired (Phase 6).
- `packages/core/src/crm/crm.test.ts` deletes all CRM rows of the shared
  test database before each test; suites running in parallel against one
  database can interfere. `turbo test` with every package at once failed
  2 of 4 runs here (a `packages/jobs` BullMQ test under load; turbo then
  stops the other packages); one suite at a time passes. Not fixed.
- `apps/web/__tests__/api/webhooks/stripe.test.ts` never imports the
  route it names (asserts on mocks only).
- A test in `apps/api/src/routes/v1/invoices.test.ts` named "returns 404
  for an invoice in another workspace" asserts 200 with the owner's key;
  the real cross-tenant check is in `cross-tenant.test.ts`.
- Re-review fixes `f8ab4c0` to `6c59013` (eight commits) fail
  `packages/jobs`' type-check; `04defd7` fixes it. The history was not
  rewritten (see the re-review table).
- Commits to fix in the history cleanup (done before the re-review): `32ca62d` fails the API
  type-check (fixed by `171db22`); `938fb19` fails its own CSP test (fixed
  by `dbb2739`); `e9516fc` also regenerates `openapi.json` (stale at
  `27c817d`); `2b642a1` is labelled `test` but changes the tenant guard;
  `959ebbc` (motion) also carries the e2e spec moves of `822d4b7`.

## Needs the owner

- A chartered accountant's review of the GST vectors and the two Rule 46
  readings above.
- Razorpay test keys, a Stripe test account, the demo environment accounts.
  The demo seed sets no Razorpay keys (`8aa1817`); Kaveri Studio's payment
  links answer `not_configured` until test keys are added in Settings.

## Review findings and fixes

C = critical, H = high, M = medium, L = low.

| #   | Finding                                                                                                   | Outcome                                                                                                                                                          | Commits                                               |
| --- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| C1  | Razorpay event of one workspace could pay another's invoice                                               | Fixed: event stores its workspace, lookups filtered by it, amount and currency checked                                                                           | `5fbb4ac`                                             |
| H1  | Tenant guard broke automations (type-check and tests red)                                                 | Fixed                                                                                                                                                            | `0f522db`                                             |
| H2  | Wait steps never resumed; approve didn't resume; approval race; role unchecked; move_deal stage unchecked | Fixed; also found: send_email never sent its email (`80ed5a4`). "No approval step" left as the design describes                                                        | `e0c8ce2`, `4802867`, `0c28a20`, `80ed5a4`            |
| H3  | Public widget API: open origins, Referer fallback, scopes, lead fields, quote by id, /pay wiring          | Fixed; publishable keys can be created with origins                                                                                                              | `9978c51`, `32ca62d`, `e9516fc`, `55913c6`, `03978e9` |
| H4  | Push dispatch sent every outbox id as webhooks.fanout                                                     | Fixed: routed like the relay                                                                                                                                     | `3879c29`                                             |
| H5  | jobs-drain never generated the Prisma client; schedule                                                    | Fixed (hourly, production mode)                                                                                                                                  | `09f81c4`                                             |
| H6  | Old Stripe endpoint not on ProviderWebhookEvent                                                           | Fixed with a both-endpoints test                                                                                                                                 | `a5d25d0`                                             |
| H7  | GST engine not wired; reverse-charge vector wrong; CA claim                                               | Fixed                                                                                                                                                            | `26b6642`, `86741f3`, `c6eb1e0`, `00dc18a`            |
| H8  | CSP not tightened                                                                                         | Fixed: nonce CSP from one source                                                                                                                                 | `938fb19`, `dbb2739`                                  |
| M1  | Idempotency keys stranded; secret stored in clear                                                         | Fixed                                                                                                                                                            | `f9f57c0`                                             |
| M2  | No API cross-tenant suite; guard skipped unique lookups                                                   | Fixed                                                                                                                                                            | `2b642a1`                                             |
| M3  | Phase 3/4 E2E run signed out; widget/axe not in CI                                                        | Fixed                                                                                                                                                            | `822d4b7`                                             |
| M4  | Visual 11/21 failing                                                                                      | 7 snapshots re-recorded (intended UI changes, measured in the commits); the portal failures were a date time-bomb in the fixtures                                | `368c274`, `98d980a`, `00b5d0b`                       |
| M5  | Kanban keyboard DnD                                                                                       | Fixed                                                                                                                                                            | `657d66d`, `8b38417`                                  |
| M6  | RTK singleton; SSR test; 99 edits                                                                         | Fixed                                                                                                                                                            | `b0c9d24`                                             |
| M7  | NumberSequence first-row race                                                                             | Fixed                                                                                                                                                            | `5f9cb87`                                             |
| M8  | Lead import                                                                                               | Fixed                                                                                                                                                            | `6d3aa01`                                             |
| M9  | Payment links charged total                                                                               | Fixed                                                                                                                                                            | `cb5f188`                                             |
| M10 | `.env.local` overrode exported DATABASE_URL                                                               | Fixed                                                                                                                                                            | `a1f5909`                                             |
| M11 | Automation builder UI                                                                                     | Rebuilt per the design                                                                                                                                            | `959ebbc`, `a7278ec`                                  |
| L1  | Poison events re-driven forever                                                                           | Fixed: dead-letter after 10                                                                                                                                      | `106e275`                                             |
| L2  | QStash exhaustion; /metrics public; auth-failure and burst limits; SSRF ranges                            | Fixed                                                                                                                                                            | `2b200f4`, `e5dffd8`, `c28d73f`, `570b230`            |
| L3  | webhooks:manage scope leaking onto later routes                                                           | Finding did not hold at the tip: `030598e` had already moved `requireScopes` onto each webhook route; the CRM tests call /v1 with keys lacking `webhooks:manage` | —                                                     |
| L4  | /api/vitals unlimited; perf test measured focus()                                                         | Fixed                                                                                                                                                            | `6723e8a`, `495f8fb`                                  |
| L5  | Vercel crons; missing Phase 2 items                                                                       | Recurring cron removed; the rest deferred (see above)                                                                                                            | `5730019`                                             |

Also added: widget SRI and CI size check (`9c32767`).

## Re-review findings and fixes (second review of `e8daf1a`)

Each finding was checked against the code before fixing. Each fix has a
test that failed before it (or with its guard reverted) and passes after.

| #   | Finding                                                                | Outcome                                                                                                                                                                                                                                                                      | Commits                                               |
| --- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| H1  | Concurrent automation ticks skipped the approval                       | Confirmed (test ended at step 2). Every transition is conditional on (step, running); move_deal and its advance in one transaction                                                                                                                                           | `f8ab4c0`, `04defd7`                                  |
| H2  | GST numbers repeat each FY, breaking the unique key on 1 April         | Confirmed. FY in the number: `INV/26-27/0001`; test stores invoices numbered 31 Mar 23:59 and 1 Apr 00:00 IST                                                                                                                                                                | `4d1d033`                                             |
| H3  | Edit, duplicate, auto-create, recurring bypass GST pricing and Rule 46 | Confirmed; also found on the legacy `/api/v1` invoice routes and in two cross-tenant recurring server actions (deleted). `actions.ts` split first (pure move)                                                                                                                | `6577132`, `19e7145`, `27eb8fe`, `e48bf32`, `6c59013` |
| H4  | Checkout throws when `payment_intent` is null                          | Confirmed from Stripe's 2022-08-01 changelog ("a PaymentIntent is created when the Session is confirmed"), which the pinned 2026-08-26.dahlia includes. Session id stored, `checkout.session.completed` reconciles                                                           | `091afbd`                                             |
| H5  | Razorpay orders use the platform key                                   | Confirmed. Per-workspace key pair, `not_configured` without keys                                                                                                                                                                                                             | `91d07af`                                             |
| M6  | Lead migration fails on emails differing only by case                  | Confirmed (23505). One lead per group lower-cased, others flagged in their message; migration edited in place (never deployed)                                                                                                                                               | `f146bf2`                                             |
| M7  | Drain omits `automations.tick`                                         | Confirmed. Drain schedule derived from `SCHEDULES`                                                                                                                                                                                                                           | `32a82be`                                             |
| M8  | Automation actions lack a role check; approval notifies nobody         | Confirmed. Owner/admin only; in-app notification to members who may decide. Email not added                                                                                                                                                                                  | `9be1a81`, `0aa4935`                                  |
| M9  | Four guards without a biting test                                      | Confirmed for all four; tests added, each reverted once and seen red                                                                                                                                                                                                         | `88a0f82`, `23ee2c6`                                  |
| M10 | Outbox status read once; global sweep in a test                        | Confirmed. Waits for `done`; sweeps only the suite's rows (the job wiring to the sweeper is no longer exercised there)                                                                                                                                                       | `f0205d6`                                             |
| M11 | Razorpay refunds overwrite instead of adding up                        | Confirmed. Refunds accumulate; the over-refund check uses the total                                                                                                                                                                                                          | `b119dcf`                                             |
| L12 | Error toast in the darwin dashboard baseline                           | Cause: hydration mismatch of "N seconds ago" in Recent Activity (React #418 → global error toast). Fixed; darwin dashboard re-recorded (diffs in the commit); linux had no toast and was not re-recorded. Also found: a kept session after a re-seed rendered the error page | `2a21fd7`, `26e06a2`, `83cb402`                       |
| L13 | 30 baselines per platform but 21 tests                                 | Not a defect: 21 tests take 30 screenshots (three tests take two each), all compared; CI's "10 key pages x 3 widths" is accurate. No change                                                                                                                                  | —                                                     |
| L14 | `<span>` inside `<ol>` in the step list                                | Fixed                                                                                                                                                                                                                                                                        | `5e556eb`                                             |
| L15 | Missing place of supply silently becomes inter-state                   | Fixed: `validation_error` for a domestic supply without both states                                                                                                                                                                                                          | `534ee58`                                             |
| L16 | CSP violations in a real browser                                       | One found on every form page: Zod 4's `Function('')` probe (caught, so never logged). Zod set jitless; CSP test now listens for the violation event                                                                                                                          | `e4afd9b`                                             |

Mid-history: `f8ab4c0` to `6c59013` fail `packages/jobs`' type-check
(`tickAutomationRun`'s return type), fixed by `04defd7`. Tests passed at
those commits; the check that missed it was core's `tsc` alone.

## Third review findings and fixes (narrow review of `31e4eeb`)

Each finding was read in the code first. Each fix has a test that failed
before it (or with its guard reverted) and passes after.

| #   | Finding                                                                            | Outcome                                                                                                                                                                                                                                                                                                                                                                                             | Commits                         |
| --- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| H1  | `/api/v1/invoices/:id/send` issues a draft without the Rule 46 gate                | Confirmed (an API key could send a GST draft without HSN: 200). Now 422 with the reasons, before any email. The search for other ways out of draft found two more: `recordPayment` (draft → partial/paid, now gated) and the dashboard's Stripe payment intent (refused for drafts, as `apps/api`'s payment link already was)                                                                       | `91c2a4e`, `4a8093b`, `4dbcb89` |
| M1  | move_deal race test does not exercise the conditional transition; deal moved twice | Test gap confirmed: with status/step removed from `transition()` it stayed green. "Moved twice" did not hold at `31e4eeb`: counting writes showed one deal update. The step now moves through `moveDealInTx` (won/lost dates, a `stage_changed` activity) in the winning tick's transaction; the test counts deal updates and activities and goes red without the condition                         | `82359c0`, `d12a825`            |
| M2  | Recurring GST copy that cannot be priced throws and retries forever                | Confirmed, with a correction: a client without a state code alone does not throw (pricing falls back to the supplier's state); it throws when the business profile has none, for a composition supplier, or with an invoice discount. Such a series is now paused, the reason recorded on the parent and the owners notified in the app                                                             | `3ed1bb1`                       |
| L1  | Wait start should require `waitingSince IS NULL`                                   | Confirmed: two concurrent ticks each scheduled the wait's end. Fixed                                                                                                                                                                                                                                                                                                                                | `de56eff`                       |
| L2  | Stripe: expired / async-failed sessions; amount and currency not compared          | Both confirmed and fixed (see Deviations)                                                                                                                                                                                                                                                                                                                                                           | `9972156`, `2c1c4cb`            |
| L3  | Credit notes not numbered per FY; number at draft vs issue                         | Credit notes now `CN/26-27/0001` in a GST workspace. Numbering at issue not done; why is under Deviations                                                                                                                                                                                                                                                                                           | `f2a6e5a`                       |
| L4  | Misleading `suppressHydrationWarning` comment                                      | Fixed                                                                                                                                                                                                                                                                                                                                                                                               | `669eb90`                       |
| L5  | apps/api throttle and webhook-endpoints tests fail ~1 run in 4                     | Root cause: supertest listens on `::` and connects to 127.0.0.1; macOS can give that socket a port another process holds on 127.0.0.1 only, which then answers (seen: a 405 where only 401 exists, a body without `data`; reproduced with a two-server script). Tests now bind 127.0.0.1 through `src/testing/request.ts`. Before: 1 of 12 runs failed here; after: 15 of 15 consecutive runs green | `ba0ddc2`                       |
| L6  | Demo seed stores fake Razorpay values, one plaintext in an `…Enc` column           | Fixed: keys left unset (checked on a scratch database)                                                                                                                                                                                                                                                                                                                                              | `8aa1817`                       |
| K   | Kanban keyboard E2E flake                                                          | Overlay draws a presentational card (no second `useDraggable` for the same id; the overlay had a second handle with the same name); a card between columns no longer jumps to column 0. Kanban keyboard passed 13 of 13 full runs, retries 0. Those runs exposed a second flake, lead-to-paid (2 of 7: a click before the invoice table hydrated), fixed in the test                                | `00e6fa2`, `a7dd260`, `12ea2a6` |

Paths that move an invoice out of draft, and their gate, at `12ea2a6`:
`updateInvoiceStatus` and `sendInvoice` (dashboard), `createInvoice` with
`isDraft: false`, `createInvoiceFromQuoteInternal` (portal acceptance and
`/api/v1/invoices/from-quote`, via `issueIfReady`), PATCH and
`POST …/send` on `/api/v1/invoices/:id`, recurring auto-send
(`sendIfIssuable`; a non-GST copy is created as sent, where the gate is a
no-op), and `recordPayment` all run `assertReadyToIssue`. Online payments
refuse drafts (`createInvoicePaymentIntent`, `apps/api` payment links), so
Stripe and Razorpay webhooks cannot reach a draft. Other status writes
(overdue marking, portal view, refunds) never start from draft.

## Checks at the tip

Run on 2026-08-09 in a fresh `git worktree` with no `.env` files, Node
24.21.0, Postgres 17 + pgvector, stripe-mock 0.205.0, Redis 7; a fresh
database per suite, suites run one at a time. Install, tests, build,
migration and OpenAPI checks ran at `ba0ddc2`; `12ea2a6` changes only an
E2E spec, and type-check, lint, E2E and visual ran at `12ea2a6`. The
commits after it change only this document and `phase-3.md`.

| Check                                                                | Result                                                                                                                                   |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                     | ok                                                                                                                                       |
| `pnpm type-check --force`                                            | 14/14 tasks                                                                                                                              |
| `pnpm lint`                                                          | 0 errors (56 web, 2 widget warnings)                                                                                                     |
| Tests with Postgres + stripe-mock + Redis                            | core 263, jobs 56, database 39, contracts 18, api 193, widget 12, web 1173: all passed                                                   |
| Tests without services                                               | core 151 (112 skipped), jobs 34 (22), database 27 (12), contracts 18, api 51 (142), widget 12, web 1129 (44): all passed                 |
| apps/api with services, consecutive runs                             | 15 of 15 green after `ba0ddc2` (1 of 12 failed before it)                                                                                |
| `pnpm build`                                                         | 4/4 tasks                                                                                                                                |
| `prisma migrate deploy` + `db:migrate:check` on a fresh DB           | "No difference detected."                                                                                                                |
| OpenAPI regenerate + `git diff --exit-code`                          | no diff                                                                                                                                  |
| E2E, `playwright.flows.config.ts`, all projects, CI=1, `--retries=0` | 6 of 6 full runs 19/19 at `12ea2a6`. At `ba0ddc2`: 5 of 7 (lead-to-paid failed twice, fixed by `12ea2a6`). Kanban keyboard passed all 13 |
| Visual, macOS                                                        | 21/21 tests (30 screenshots), retries 0                                                                                                  |
| Visual, linux/arm64 Playwright container                             | 21/21 tests (30 screenshots), retries 0                                                                                                  |
| Type-check and lint at each commit after `31e4eeb`                   | 16 of 16 commits pass both                                                                                                               |

Not run: GitHub Actions itself (CI has never run on GitHub), the
jobs-drain workflow on a real runner, a live Stripe or Razorpay test-mode
payment.

## Verified on the deployed demo (2026-08-20)

Run against the free demo (Vercel Hobby, Neon, Redis Cloud, Upstash QStash,
Supabase Storage, Sentry, Stripe and Razorpay test mode, Gemini free tier)
from commits `8011d97` and `6c1748c`. Account-specific evidence (ids,
timestamps) is kept outside the repo.

- The widget, embedded on a page served from an allowed origin, opens
  Razorpay checkout for an invoice; the same call with another `Origin`
  is refused (401 "Origin not allowed"). The CORS preflight itself answers
  for any origin.
- Web vitals (CLS, LCP, FCP, INP, TTFB) from the live site reach
  `/api/vitals` and are logged.
