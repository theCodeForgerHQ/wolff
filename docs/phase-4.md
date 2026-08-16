# Phase 4: Frontend: RTK, widget, automation builder

Branch `phase4-rtk-widget-automation`. **Phase 4 is not closed**, and the
v0.5 milestone (README v0.5, live demo, video, tag `v0.5.0`) is **not done**:
nothing is deployed and no tag was made.

The Phase 4 build (up to `3590d9c`) was reviewed twice, together with
Phases 2 and 3, and the fixed branch (tip `b9993e4`, tagged
`phase4-pre-rereview-fixes`) was reviewed again. The second half of this
document lists every finding and what happened to it. Hashes in the first
review table are from before the history cleanup; hashes in the
re-review table are current.

## State of the Phase 4 criteria

| Criterion                                                             | State                | Evidence                                                                                                                                                                            |
| --------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RTK store per request/mount, slices, redux-undo, listener persistence | Met                  | `apps/web/lib/store`; no module-level store (guard test in `__tests__/lib/store/quote-builder-rtk.test.tsx`)                                                                        |
| Undo/redo across 100 edits                                            | Met                  | Same test file: 100 edits undone to the initial document and redone. `limit` is 101 (redux-undo counts the present state); the design says `limit: 100`                              |
| SSR isolation (two concurrent requests get distinct stores)           | Met, weakly proven   | 20 interleaved `renderToString` renders each show only their own document. This test also passes with the old singleton; the guard against a module-level store is what fails on it |
| Widget lead-form, invoice-pay, quote-link; publishable keys           | Met (mock providers) | `apps/widget`, `apps/api/src/routes/v1/public.ts`; keys created in Settings → API with allowed origins                                                                              |
| Widget ≤ 60 kB gzip                                                   | Met                  | size-limit: 10.8 kB (IIFE) / 10.7 kB (ES); runs in CI's build job                                                                                                                   |
| Widget interactive ≤ 300 ms after DOMContentLoaded, throttled         | Met locally          | `e2e/widget/perf.spec.ts`: Fast 3G + 4x CPU, the widget's own performance mark                                                                                                      |
| SRI hash per release                                                  | Met (build output)   | `dist/sri.json` written by `apps/widget/scripts/sri.mjs`; not published anywhere (no CDN)                                                                                           |
| Rejected from a non-allowed origin                                    | Met                  | `apps/api/src/routes/v1/public.test.ts` (exact Origin, empty list denies, no Referer)                                                                                               |
| Automation run pauses at approval and resumes on approve (E2E)        | Met                  | `e2e/product/automation-approval.spec.ts`; resuming in the worker is covered by `packages/jobs/src/jobs.test.ts`. The pause notifies approvers in the app (`c3c4d26`); no email     |
| axe clean on builder, Kanban, widget, automations                     | Met                  | `e2e/product/axe.spec.ts`, `e2e/widget/axe.spec.ts`                                                                                                                                 |
| CSP tightening                                                        | Met                  | `apps/web/lib/security/csp.ts`, `e2e/flows/csp.spec.ts`; 27 pages opened in Chromium with no violation after `fbed765` (pay dialog not opened)                                      |
| web-vitals reporting                                                  | Partly               | Reported to `/api/vitals` and logged; no Sentry/OTel metric, no p75 table in the README                                                                                             |

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
  routes price GST and gate issuing since `6138fb5`; their port to
  `apps/api` stays in Phase 6b.
- GST numbers carry the financial year (`INV/26-27/0001`, 14 characters).
  Credit notes still use one running `CN-0001` sequence; the design does not
  say how credit notes are numbered, so this is left for the owner's CA.
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
  database can interfere (seen once as a jobs-suite timeout under load).
- `apps/web/__tests__/api/webhooks/stripe.test.ts` never imports the
  route it names (asserts on mocks only).
- A test in `apps/api/src/routes/v1/invoices.test.ts` named "returns 404
  for an invoice in another workspace" asserts 200 with the owner's key;
  the real cross-tenant check is in `cross-tenant.test.ts`.
- Re-review fixes `7c46988` to `6138fb5` (eight commits) fail
  `packages/jobs`' type-check; `c5d63e1` fixes it. The history was not
  rewritten (see the re-review table).
- Commits to fix in the history cleanup (done before the re-review): `9106528` fails the API
  type-check (fixed by `3c8a6f4`); `b9eb565` fails its own CSP test (fixed
  by `e4c3e7e`); `159864a` also regenerates `openapi.json` (stale at
  `3590d9c`); `4478be8` is labelled `test` but changes the tenant guard;
  `b44a88d` (motion) also carries the e2e spec moves of `b05ccfe`.

## Needs the owner

- A chartered accountant's review of the GST vectors and the two Rule 46
  readings above.
- Razorpay test keys, a Stripe test account, the demo environment accounts.

## Review findings and fixes

C = critical, H = high, M = medium, L = low.

| #   | Finding                                                                                                   | Outcome                                                                                                                                                          | Commits                                               |
| --- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| C1  | Razorpay event of one workspace could pay another's invoice                                               | Fixed: event stores its workspace, lookups filtered by it, amount and currency checked                                                                           | `60ce0a6`                                             |
| H1  | Tenant guard broke automations (type-check and tests red)                                                 | Fixed                                                                                                                                                            | `9ca5040`                                             |
| H2  | Wait steps never resumed; approve didn't resume; approval race; role unchecked; move_deal stage unchecked | Fixed; also found: send_email never sent its email (`bb6fa1b`). "No approval step" left as the design describes                                                        | `1a9e318`, `4a5c6d2`, `24fbf9c`, `bb6fa1b`            |
| H3  | Public widget API: open origins, Referer fallback, scopes, lead fields, quote by id, /pay wiring          | Fixed; publishable keys can be created with origins                                                                                                              | `b1d8e03`, `9106528`, `159864a`, `c787613`, `c0d603b` |
| H4  | Push dispatch sent every outbox id as webhooks.fanout                                                     | Fixed: routed like the relay                                                                                                                                     | `4eca243`                                             |
| H5  | jobs-drain never generated the Prisma client; schedule                                                    | Fixed (hourly, production mode)                                                                                                                                  | `b434634`                                             |
| H6  | Old Stripe endpoint not on ProviderWebhookEvent                                                           | Fixed with a both-endpoints test                                                                                                                                 | `0b8e899`                                             |
| H7  | GST engine not wired; reverse-charge vector wrong; CA claim                                               | Fixed                                                                                                                                                            | `1b3f9e9`, `093c894`, `db08e2a`, `248c968`            |
| H8  | CSP not tightened                                                                                         | Fixed: nonce CSP from one source                                                                                                                                 | `b9eb565`, `e4c3e7e`                                  |
| M1  | Idempotency keys stranded; secret stored in clear                                                         | Fixed                                                                                                                                                            | `dd606ae`                                             |
| M2  | No API cross-tenant suite; guard skipped unique lookups                                                   | Fixed                                                                                                                                                            | `4478be8`                                             |
| M3  | Phase 3/4 E2E run signed out; widget/axe not in CI                                                        | Fixed                                                                                                                                                            | `b05ccfe`                                             |
| M4  | Visual 11/21 failing                                                                                      | 7 snapshots re-recorded (intended UI changes, measured in the commits); the portal failures were a date time-bomb in the fixtures                                | `5c02f5b`, `692459c`, `4becaf0`                       |
| M5  | Kanban keyboard DnD                                                                                       | Fixed                                                                                                                                                            | `f88ff64`, `fa3c599`                                  |
| M6  | RTK singleton; SSR test; 99 edits                                                                         | Fixed                                                                                                                                                            | `ffe4d88`                                             |
| M7  | NumberSequence first-row race                                                                             | Fixed                                                                                                                                                            | `d5b2796`                                             |
| M8  | Lead import                                                                                               | Fixed                                                                                                                                                            | `a776776`                                             |
| M9  | Payment links charged total                                                                               | Fixed                                                                                                                                                            | `b24b323`                                             |
| M10 | `.env.local` overrode exported DATABASE_URL                                                               | Fixed                                                                                                                                                            | `4917dda`                                             |
| M11 | Automation builder UI                                                                                     | Rebuilt per the design                                                                                                                                            | `b44a88d`, `3d3e447`                                  |
| L1  | Poison events re-driven forever                                                                           | Fixed: dead-letter after 10                                                                                                                                      | `2bf4a69`                                             |
| L2  | QStash exhaustion; /metrics public; auth-failure and burst limits; SSRF ranges                            | Fixed                                                                                                                                                            | `4af5e21`, `305b928`, `9fc7862`, `70853af`            |
| L3  | webhooks:manage scope leaking onto later routes                                                           | Finding did not hold at the tip: `c1366d5` had already moved `requireScopes` onto each webhook route; the CRM tests call /v1 with keys lacking `webhooks:manage` | —                                                     |
| L4  | /api/vitals unlimited; perf test measured focus()                                                         | Fixed                                                                                                                                                            | `172395b`, `7ab5115`                                  |
| L5  | Vercel crons; missing Phase 2 items                                                                       | Recurring cron removed; the rest deferred (see above)                                                                                                            | `43c8554`                                             |

Also added: widget SRI and CI size check (`ef325d1`).

## Re-review findings and fixes (second review of `b9993e4`)

Each finding was checked against the code before fixing. Each fix has a
test that failed before it (or with its guard reverted) and passes after.

| #   | Finding                                                                | Outcome                                                                                                                                                                                                                                                                      | Commits                                               |
| --- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| H1  | Concurrent automation ticks skipped the approval                       | Confirmed (test ended at step 2). Every transition is conditional on (step, running); move_deal and its advance in one transaction                                                                                                                                           | `7c46988`, `c5d63e1`                                  |
| H2  | GST numbers repeat each FY, breaking the unique key on 1 April         | Confirmed. FY in the number: `INV/26-27/0001`; test stores invoices numbered 31 Mar 23:59 and 1 Apr 00:00 IST                                                                                                                                                                | `76b761b`                                             |
| H3  | Edit, duplicate, auto-create, recurring bypass GST pricing and Rule 46 | Confirmed; also found on the legacy `/api/v1` invoice routes and in two cross-tenant recurring server actions (deleted). `actions.ts` split first (pure move)                                                                                                                | `e72e6c3`, `4e6d104`, `da7d1f9`, `2252f72`, `6138fb5` |
| H4  | Checkout throws when `payment_intent` is null                          | Confirmed from Stripe's 2022-08-01 changelog ("a PaymentIntent is created when the Session is confirmed"), which the pinned 2026-08-26.dahlia includes. Session id stored, `checkout.session.completed` reconciles                                                           | `dc15428`                                             |
| H5  | Razorpay orders use the platform key                                   | Confirmed. Per-workspace key pair, `not_configured` without keys                                                                                                                                                                                                             | `3195c0d`                                             |
| M6  | Lead migration fails on emails differing only by case                  | Confirmed (23505). One lead per group lower-cased, others flagged in their message; migration edited in place (never deployed)                                                                                                                                               | `cd27aa1`                                             |
| M7  | Drain omits `automations.tick`                                         | Confirmed. Drain schedule derived from `SCHEDULES`                                                                                                                                                                                                                           | `9d0cc38`                                             |
| M8  | Automation actions lack a role check; approval notifies nobody         | Confirmed. Owner/admin only; in-app notification to members who may decide. Email not added                                                                                                                                                                                  | `a353191`, `c3c4d26`                                  |
| M9  | Four guards without a biting test                                      | Confirmed for all four; tests added, each reverted once and seen red                                                                                                                                                                                                         | `b88f73e`, `276eb51`                                  |
| M10 | Outbox status read once; global sweep in a test                        | Confirmed. Waits for `done`; sweeps only the suite's rows (the job wiring to the sweeper is no longer exercised there)                                                                                                                                                       | `72c96e8`                                             |
| M11 | Razorpay refunds overwrite instead of adding up                        | Confirmed. Refunds accumulate; the over-refund check uses the total                                                                                                                                                                                                          | `9f5b5fb`                                             |
| L12 | Error toast in the darwin dashboard baseline                           | Cause: hydration mismatch of "N seconds ago" in Recent Activity (React #418 → global error toast). Fixed; darwin dashboard re-recorded (diffs in the commit); linux had no toast and was not re-recorded. Also found: a kept session after a re-seed rendered the error page | `3557318`, `d05264f`, `6410384`                       |
| L13 | 30 baselines per platform but 21 tests                                 | Not a defect: 21 tests take 30 screenshots (three tests take two each), all compared; CI's "10 key pages x 3 widths" is accurate. No change                                                                                                                                  | —                                                     |
| L14 | `<span>` inside `<ol>` in the step list                                | Fixed                                                                                                                                                                                                                                                                        | `353d465`                                             |
| L15 | Missing place of supply silently becomes inter-state                   | Fixed: `validation_error` for a domestic supply without both states                                                                                                                                                                                                          | `523a2eb`                                             |
| L16 | CSP violations in a real browser                                       | One found on every form page: Zod 4's `Function('')` probe (caught, so never logged). Zod set jitless; CSP test now listens for the violation event                                                                                                                          | `fbed765`                                             |

Mid-history: `7c46988` to `6138fb5` fail `packages/jobs`' type-check
(`tickAutomationRun`'s return type), fixed by `c5d63e1`. Tests passed at
those commits; the check that missed it was core's `tsc` alone.

## Checks at the tip

Run on 2026-08-09 at `e51683c` (the commit before this one, which only
adds this section) in a fresh `git worktree` with no `.env` files,
Node 24.21.0, Postgres 17 + pgvector, stripe-mock 0.205.0, Redis 7; a
fresh database per suite, suites run one at a time.

| Check                                                      | Result                                                                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `pnpm install --frozen-lockfile`                           | ok                                                                                                                       |
| `pnpm type-check`                                          | 14/14 tasks                                                                                                              |
| `pnpm lint`                                                | 0 errors (56 web, 2 widget warnings)                                                                                     |
| Tests with Postgres + stripe-mock + Redis                  | core 261, jobs 56, database 39, contracts 18, api 185, widget 12, web 1165: all passed                                   |
| Tests without services                                     | core 151 (110 skipped), jobs 34 (22), database 27 (12), contracts 18, api 48 (137), widget 12, web 1125 (40): all passed |
| `pnpm build`                                               | 4/4 tasks                                                                                                                |
| `prisma migrate deploy` + `db:migrate:check` on a fresh DB | "No difference detected." (needs `SHADOW_DATABASE_URL`)                                                                  |
| OpenAPI regenerate + `git diff --exit-code`                | no diff                                                                                                                  |
| E2E, `playwright.flows.config.ts`, all projects, CI=1      | 19/19 with CI's one retry (1 flaky: Kanban keyboard). With `--retries=0`: 3 runs of 4 green                              |
| Visual, macOS                                              | 21/21 tests (30 screenshots)                                                                                             |
| Visual, linux/arm64 Playwright container                   | 21/21 tests (30 screenshots)                                                                                             |

Open finding from this run: `e2e/product/kanban-keyboard.spec.ts` fails
about one full run in four (the "is over <stage>" announcement after
ArrowRight does not appear); alone it passed 5 of 5. Not investigated
further; it was not touched in the re-review.

Not run: GitHub Actions itself (CI has never run on GitHub), the
jobs-drain workflow on a real runner, a live Stripe or Razorpay test-mode
payment.
