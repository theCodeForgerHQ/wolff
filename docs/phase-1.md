# Phase 1: upgrades and foundation

Branch `phase1-upgrades`, 43 commits on top of `phase0-baseline` (`1cfdd44`):
25 for the phase itself, 12 that fix the findings of a peer review
(see [Review findings and fixes](#review-findings-and-fixes)) and 6 that close
the phase (see [Closing the phase](#closing-the-phase)).
Phase 1 has a task list and a definition of done (DoD). The
starting point is recorded in [`docs/baseline.md`](baseline.md); the Stripe
analysis is in [`docs/upgrades/stripe.md`](upgrades/stripe.md).

## What changed

| Area           | Before                                  | After                                                                                          | Commit               |
| -------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------- |
| Baseline       | none                                    | `docs/baseline.md`, 30 screenshot baselines (10 pages × 375/768/1440) taken before any upgrade | `6820fac`            |
| Schema drift   | `migrate diff` not empty                | catch-up migration; diff empty                                                                 | `925e8df`            |
| Postgres       | 16 (`postgres:16-alpine`)               | 17.10 + pgvector 0.8.2 (`pgvector/pgvector:0.8.2-pg17`) in all compose files and CI            | `406866d`            |
| Docker runtime | `node:20.18-alpine`                     | `node:24-alpine`                                                                               | `f8b4c2d`            |
| TypeScript     | `^5.7`                                  | `5.9.3` (exact); `@types/node` 24                                                              | `28a7839`            |
| Zod            | 3.25                                    | 4.6.5, `@hookform/resolvers` 5.9                                                               | `60c03e7`            |
| Prisma         | 6.19 (Rust engine)                      | 7.10.0 exact: `prisma-client` generator, pg driver adapter, `prisma.config.ts`                 | `1db24a6`            |
| Auth adapter   | `@auth/prisma-adapter`                  | Wolff-schema adapter inside the encryption wrapper (D10 fallback)                              | `9e1816f`            |
| Next.js        | 15.5.26, `middleware.ts`                | 16.3.7 exact, `proxy.ts`, Turbopack builds, flat ESLint config                                 | `854a407`, `71cfbb6` |
| Tailwind       | 3.4 + `tailwind.config.ts`              | 4.3.3 CSS-first `@theme` via the official upgrade tool                                         | `45c6793`, `58d1299` |
| Stripe         | SDK 17.7, API `2025-02-24.acacia`       | SDK 22.6.2, API `2026-08-26.dahlia`                                                            | `41a8d94`, `93138b9` |
| Vitest         | 2.1                                     | 5.0.2 (+ Vite 8, plugin-react 6.1.1)                                                           | `f296335`            |
| Playwright     | `^1.49` (resolved 1.63)                 | `1.63.0` exact                                                                                 | `8096177`            |
| Sentry         | none                                    | `@sentry/nextjs` 11.1.0, disabled unless a DSN is set                                          | `1f626e9`            |
| E2E            | none for the DoD                        | login (credentials + mock Google OIDC), quote → invoice → Stripe payment                       | `72fa680`, `fd61b4e` |
| CI             | lint, types, unit, build on Postgres 15 | + migrations check, DB/stripe-mock suites, E2E job, Postgres 17                                | `29263c1`            |

Fixes that came out of the work, each in its own `fix:` commit:

- `edb84fa` pino's `pino/file` transport crashed every logging route in
  `next dev` (`Cannot find module …/vendor-chunks/lib/worker.js`).
- `9e1816f` First-time Google/GitHub sign-in could never create a user:
  `@auth/prisma-adapter` writes the Auth.js reference schema, not Wolff's.
- `93138b9` (from a security review of the Stripe commit) A refund that
  rounded to 0 cents was sent as a _full_ refund; the functions in
  `lib/services/stripe.ts` validate Stripe ids, amounts, currency, email and
  metadata before calling the SDK; the stripe-mock override accepts loopback
  hosts only. At that commit six calls still used the SDK client directly and
  skipped the schemas. `daa17ec` moved them into the service and stopped
  exporting the client, so every request the app sends to Stripe is now
  validated first. Webhook verification (`constructEvent`) sends nothing; it
  checks the signature of what Stripe sent.
- `d57cea0` The portal's Pay button showed "online payment is not yet
  available" for every invoice since the portal redesign (`334c165`).

## Definition of done

### Test count ≥ baseline, all green

|                                                         | Baseline (`1cfdd44`)  | Now                                               |
| ------------------------------------------------------- | --------------------- | ------------------------------------------------- |
| `vitest run` without services                           | 989 tests, 989 passed | **1122 tests: 1100 passed, 22 skipped, 0 failed** |
| with `TEST_DATABASE_URL` + `STRIPE_MOCK_URL` (as in CI) | n/a                   | **1122 passed, 0 skipped**                        |

The 22 skipped tests need a service: the Postgres adapter integration tests
(8), the two payment sequences against Postgres (3 for pay-again, 4 for a
decline followed by a retry) and the stripe-mock contract tests (7); CI
provides both services. Tests added in the phase: auth
adapter mapping (4) and integration (7), Stripe webhook signatures (5),
stripe-mock contracts (7), Stripe input validation (22), loopback URL rule (8),
portal payment component (4), Sentry options (6). The review fixes added 66
more, listed per finding below.

Commands: `TEST_DATABASE_URL=… STRIPE_MOCK_URL=http://localhost:12111 npx turbo test`.

### `pnpm build` green

`pnpm build` passes (Next 16.3.7, Turbopack). `pnpm type-check` passes (6 of 6
packages).
`pnpm lint` has 0 errors and 56 warnings (baseline: 0 and 26); the increase is
the React Compiler rules that eslint-config-next 16 brings in, see Known issues.
The Docker image builds and, run against Postgres 17, starts on Node 24.21 and
returns `{"status":"healthy","services":{"database":"connected"}}` from
`/api/health`.

### `prisma migrate diff` empty

`pnpm db:migrate:check` (`prisma migrate diff --from-migrations
prisma/migrations --to-schema prisma/schema.prisma --exit-code`) prints "No
difference detected." and exits 0 against Postgres 17. At baseline the same
comparison produced 86 lines of drift, fixed by `925e8df`. CI's `migrations`
job runs `migrate deploy` → `migrate:check` → `db:seed` on a fresh database.

### Screenshot diffs within `maxDiffPixelRatio 0.01`, or a reviewed update

`playwright.visual.config.ts`: 10 pages × 3 widths = 30 screenshots in 21
Playwright tests. After every upgrade the suite was re-run on a fresh
database:

| Upgrade                                                | Result                                                                                                                                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres 17, Prisma 7, Next 16, Stripe, Vitest, Sentry | 30/30 within 0.01                                                                                                                                                                      |
| Tailwind 4                                             | 22/30 within 0.01 after three fixes (shadows, Label spacing, variant props); 8 updated in `58d1299`, which lists each remaining difference and why it is intended Tailwind 4 behaviour |

Every baseline set was confirmed stable with 2–3 consecutive runs before it
was committed.

Two baseline sets are committed, keyed by platform: `darwin` (macOS, local
runs) and `linux` (CI). At the tip both pass 21/21. The linux set is recorded
and checked with `apps/web/e2e/visual/run-in-linux.sh`, which runs the suite in
`mcr.microsoft.com/playwright:v1.63.0-noble` against the production build.

`58d1299` accepted one change it should not have: text with an opacity modifier
on `text-muted-foreground` became visible and far too faint. `500dc71` fixes it
and re-records the 9 macOS screenshots it touches (finding 8 below).

### Playwright: login (credentials + mocked Google), quote → invoice → Stripe test payment

`playwright.flows.config.ts`, 7 tests, green at the tip:

- credentials sign-in, wrong password, redirect of signed-out visitors;
- Google sign-in through `oauth2-mock-server` (discovery, PKCE, token
  exchange, id_token verification run for real): the user is created with a
  workspace they own, the account linked, the access token stored encrypted
  (`enc:`), the onboarding wizard renders, and a second sign-in reuses all of
  it; a deactivated account is sent back to the login page with an explanation;
- an accepted quote converted in the dashboard, paid from the client portal,
  confirmed by a signed `payment_intent.succeeded` webhook, ending with the
  invoice `paid` in the database and on the invoice page.

**What is mocked, honestly:** there are no Stripe or Google keys. Google is a
local OIDC server. On the server side, Stripe API calls go to `stripe-mock`,
which validates each request against Stripe's OpenAPI spec but doesn't process
payments. In the browser, Stripe.js is replaced by a stub (`e2e/flows/stripe-js-stub.ts`)
that renders a placeholder element and resolves `confirmPayment`, and the
webhook is sent by the test, signed with the endpoint secret. So the flow proves
Wolff's side of the integration (request shapes, the client-secret hand-off,
signature verification, idempotent webhook processing, state changes), not the
Stripe-hosted card form or real card networks.

## Deviations

- **Rename and rebrand: deferred.** The product name is still undecided;
  branding stays "Wolff" and the NOTICE/AGPL credit ships with the rename.
- **D10 took the fallback path**, but for a different reason than the spec
  expected: `@auth/prisma-adapter` works with Prisma 7, but it never matched
  Wolff's schema (see `9e1816f`).
- **Prisma client module format.** The design implies the ESM `prisma-client`
  output; it is generated as CommonJS (`moduleFormat = "cjs"`) because
  Playwright and the tsx seed scripts load it through `require()` and the
  workspace packages aren't `"type": "module"`.
- **Middleware runtime.** The auth middleware moved to the Node.js runtime
  (`854a407`) before the Next 16 upgrade, which then renamed it to `proxy.ts`.
- **Visual baselines are per platform.** macOS and Linux sets are both
  committed. The Linux set was recorded on linux/arm64, so CI's `e2e` job runs
  on an arm64 runner (see Known issues).
- **Stripe testing uses stripe-mock** instead of Stripe test mode (no keys).

## Known issues and follow-ups

| Issue                                                                                                                                                                                                                                                            | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seeded quotes and invoices have readable ids (`demo-quote-6`) that the UUID-only detail and edit routes reject                                                                                                                                                   | Left for the Phase 3 deterministic seed; tests use UUID clones                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `lib/auth/index.ts` reads `TRUST_HOST`, `proxy.ts` reads `AUTH_TRUST_HOST`                                                                                                                                                                                       | Both must be set for `next start` outside Vercel; unify later                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `/dashboard` hydration mismatch (React #418) raises the global error toast                                                                                                                                                                                       | Seen at baseline; masked in the visual suite, not yet fixed                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 35 findings from eslint-plugin-react-hooks 7 (React Compiler rules: `set-state-in-effect`, `refs`, `purity`, …)                                                                                                                                                  | Set to `warn` in `eslint.config.mjs`; fix before enabling the React Compiler                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Turbopack warns that `lib/services/storage.ts` and the PDF Chromium lookup trace the whole project                                                                                                                                                               | Output size only; add `turbopackIgnore` or narrow the paths                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `app/opengraph-image.tsx` and `app/twitter-image.tsx` use the deprecated Edge runtime                                                                                                                                                                            | Switch to the Node.js runtime                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Standard Connect accounts are charged with `transfer_data.destination`                                                                                                                                                                                           | Pre-existing; revisit in the Phase 3 `PaymentProvider` work (`docs/upgrades/stripe.md`)                                                                                                                                                                                                                                                                                                                                                                                                      |
| stripe-mock 0.205.0 may lag the newest API version                                                                                                                                                                                                               | Contract tests catch request-shape breaks, not the newest response fields                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Linux baselines were recorded on linux/arm64 (Apple silicon), where Chromium can't run under amd64 emulation. CI's `e2e` job was moved from `ubuntu-latest` (x86_64) to `ubuntu-24.04-arm` to match (`3e064e6`)                                                  | **Unproven until the first real run.** The workflow has never run on GitHub. Same architecture, Ubuntu release and Chromium build as the recording, 1% tolerance; but the runner installs fonts with `playwright install --with-deps`, not from the image the baselines were recorded in, and whether the arm64 runner is available to a private repository has not been checked. If it differs: run the job inside `mcr.microsoft.com/playwright:v1.63.0-noble`, or re-record on the runner |
| The macOS screenshots rendered today differ from the older committed `darwin` files by a few colour levels across whole pages (login background 248,250,252 then, 244,248,249 now), with and without the review fixes                                            | Below Playwright's per-pixel threshold, so the suite passes; cause not found. The Linux container set is the reproducible one                                                                                                                                                                                                                                                                                                                                                                |
| The `⌘K` hint in the header measures 4.34:1 (`text-muted-foreground` on the muted chip), under the AA 4.5:1                                                                                                                                                      | Same colours as at baseline; other opacity-modified text colours (`text-primary/80`, `text-foreground/50`, `text-sidebar-foreground/70`) were not measured                                                                                                                                                                                                                                                                                                                                   |
| next-auth is still `5.0.0-beta.32`                                                                                                                                                                                                                               | Pinned exactly                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| The Mac's default Node is 26.6; the project targets Node 24                                                                                                                                                                                                      | The closing checks below ran on Node 24.21 (the `node@24` npm package put first on `PATH`). The review-fix checks further down ran on 26.6                                                                                                                                                                                                                                                                                                                                                   |
| The visual suite caches its sign-in for an hour in `e2e/.auth/visual-demo.json` (gitignored). If the database is re-created within that hour the cached session points at a user that no longer exists and the 12 dashboard screenshots fail with `Unauthorized` | Harness only; a clean checkout has no such file. Delete the file after re-seeding                                                                                                                                                                                                                                                                                                                                                                                                            |
| The Stripe webhook route records the event id before it processes the event. If processing then throws, Stripe's retry is answered as a duplicate and the event is lost                                                                                          | Read from the code, not reproduced. The design replaces this in Phase 2 (event row and outbox row in one transaction, marked processed only on success)                                                                                                                                                                                                                                                                                                                                       |
| When the checkout call can't retrieve an existing PaymentIntent it marks the row `failed` and creates a second intent without cancelling the first, so both could be paid                                                                                        | Read from the code, not reproduced. Both payments would be recorded (the first through the fix in `ad411c2`) and the invoice would show as overpaid; revisit with the Phase 3 `PaymentProvider` work                                                                                                                                                                                                                                                                                         |

## Needs a person with accounts or keys

- **Stripe test account:** set the webhook endpoints' API version to
  `2026-08-26.dahlia`; run Connect onboarding, a real test-mode card payment
  through the Payment Element and a refund.
- **Google Cloud OAuth client:** one real Google sign-in to confirm the
  production provider config (the E2E uses a mock issuer).
- **Sentry project (Phase 2):** set `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN`,
  and `SENTRY_AUTH_TOKEN`/`SENTRY_ORG`/`SENTRY_PROJECT` for source maps.
- **CI:** the workflow has only been validated locally (actionlint 1.7.12,
  every job's commands run by hand). The first remote run is also the first
  run of the `e2e` job on GitHub's arm64 runner and the first comparison of the
  Linux baselines outside this machine.

## Review findings and fixes

A peer review of the 25 phase commits reported 12 findings. Each was
checked against the code before it was changed; all 12 held. Bugs were fixed
test-first: the test was written, seen to fail for the stated reason, then
made to pass.

| #   | Finding                                                                                                                               | Fix                                                                                                                                                                                                        | Commit    | Tests                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------- |
| 1   | Pay clicked again before the webhook landed marked the payment `completed` without crediting the invoice; the webhook then skipped it | The checkout call returns `alreadyReceived` (HTTP 409) for a `succeeded` or `processing` intent and writes nothing; the webhook settles it; the portal shows its "payment received" state                  | `f9d1f08` | 3 against Postgres (the exact sequence), 3 component |
| 2   | First Google/GitHub sign-in created no workspace, so `/onboarding` threw; the E2E only waited for the URL                             | `lib/auth/provision-user.ts` creates user, workspace and owner membership in one transaction, used by both the register route and the adapter; the E2E asserts the wizard renders and the workspace exists | `1ecfc4f` | 1 against Postgres, 3 unit, E2E                      |
| 3   | CI's visual step would write baselines and fail 21 of 21                                                                              | 30 Linux baselines committed; CI compares without `--update-snapshots`                                                                                                                                     | `2a6f829` | visual suite in the Linux image                      |
| 4   | A refund amount of `0` or `NaN` became a full refund                                                                                  | `toRefundMinorUnits`: only an omitted amount is a full refund; a given amount must be finite and positive                                                                                                  | `9afcf5c` | 12                                                   |
| 5   | Six SDK calls bypassed the validation that `93138b9` and this document claimed                                                        | Five new validated service functions, the client is no longer exported                                                                                                                                     | `daa17ec` | 22, and the stripe-mock contracts use them           |
| 6   | A replacement PaymentIntent reused the idempotency key and got the cancelled intent back for 24h                                      | The key ends with an attempt number (payment rows the invoice already has)                                                                                                                                 | `4b055ca` | 4, plus 2 schema cases                               |
| 7   | OAuth sign-in for a soft-deleted user failed on the unique email constraint                                                           | A `signIn` callback redirects to `/login?error=AccountDeactivated`; the login form shows the reason                                                                                                        | `8072e71` | 8 unit, E2E                                          |
| 8   | "Powered by Wolff" and dashboard secondary text became much fainter in the Tailwind 4 baseline update                                 | Measured 1.93:1 to 2.66:1 against AA's 4.5:1: a regression. All 53 `text-muted-foreground/NN` become `text-muted-foreground` (4.55:1); baselines re-recorded                                               | `500dc71` | 1 guard test, visual suite                           |
| 9   | `canPay` ignored the publishable key the payment form needs                                                                           | `canPayOnline` requires it; the non-null assertion is gone                                                                                                                                                 | `1f814cb` | 8                                                    |
| 10  | Stale comment in `proxy.ts` about Edge and Prisma                                                                                     | Rewritten                                                                                                                                                                                                  | `c948f0b` | n/a                                                  |
| 11  | `apps/web/AGENTS.md` and `apps/web/CLAUDE.md` (written by `next dev`) were committed                                                  | Removed and gitignored                                                                                                                                                                                     | `4a49f41` | n/a                                                  |
| 12  | Three commit messages were inaccurate                                                                                                 | Reworded only; the tree at the old tip and the reworded tip is identical, dates unchanged                                                                                                                  | see below | n/a                                                  |

Finding 12, by subject (rewording a commit changes its hash and those after it):

- `93138b9` "fix(security): validate every value…" said the review was of "the
  previous commit"; it was of the Stripe SDK upgrade two commits earlier.
- `854a407` was labelled `refactor` although it changes the runtime the
  middleware executes on; it is now `feat(middleware)`.
- `58d1299` said the 8 screenshots differ by 2–4% of pixels. The range is
  roughly 2–8%; the reviewer measured 6.7% and 7.6% on the two mobile portal
  screenshots. (The body already described the mask it adds to the spec.)

Checks at the tip of the review fixes, `7e358ed` (macOS, Node 26.6, Postgres
17, stripe-mock 0.205.0):

| Check                                    | Result                            |
| ---------------------------------------- | --------------------------------- |
| `pnpm type-check`                        | 6 of 6 packages pass              |
| `pnpm lint`                              | 0 errors, 69 warnings (unchanged) |
| Unit tests with Postgres and stripe-mock | 1118 passed, 0 skipped, 71 files  |
| Unit tests without services              | 1100 passed, 18 skipped           |
| `pnpm build`                             | passes                            |
| `pnpm db:migrate:check`                  | "No difference detected."         |
| E2E flows                                | 7 of 7                            |
| Visual suite, macOS                      | 21 of 21 (30 screenshots)         |
| Visual suite, Linux container (arm64)    | 21 of 21 (30 screenshots)         |

## Closing the phase

Five follow-ups after the review fixes, each in its own commit.

| Item                                                       | Outcome                                                                                                                                                                                                                                                                                                                                                                                 | Commit               |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Suspected: a `failed` payment row swallows a later success | **Real.** A declined card followed by a successful retry on the same PaymentIntent left the invoice unpaid. The test runs decline, success, late decline and repeated success against Postgres; 3 of its 4 cases failed before the fix. `failed` is no longer final; `completed` and `refunded` are                                                                                     | `ad411c2`            |
| Agent instruction files tracked at the root                | `CLAUDE.md` came with the base version; `AGENTS.md` was written by turbo and committed with `621b30e`. Both removed and ignored at any depth; turbo's `agentGuidance` is off                                                                                                                                                           | `444ec34`            |
| The pre-commit hook reformatted whole files on first touch | 561 tracked files were not Prettier-clean. They are formatted in one commit that contains only Prettier's output (`prettier --check` on every tracked ts, tsx, js, jsx, json, md, yaml, yml file and the app's css now passes). The hook also runs `eslint --fix` under `apps/web`; its 13 fixes in 7 files are a second commit. A later commit's diff now contains only its own change | `1e545d0`, `fba480e` |
| Linux baselines are arm64, the CI runner was x86_64        | The `e2e` job runs on `ubuntu-24.04-arm`. Not proven; see Known issues                                                                                                                                                                                                                                                                                                                  | `3e064e6`            |
| This document                                              | Brought in line with the above                                                                                                                                                                                                                                                                                                                                                          | this commit          |

Checks at the tip (macOS, **Node 24.21.0**, Postgres 17.10, stripe-mock
0.205.0), run after the last code change:

| Check                                                               | Result                                        |
| ------------------------------------------------------------------- | --------------------------------------------- |
| `pnpm type-check`                                                   | 6 of 6 packages pass                          |
| `pnpm lint`                                                         | 0 errors, 56 warnings                         |
| Unit tests with Postgres and stripe-mock                            | 1122 passed, 0 skipped, 72 files              |
| Unit tests without services                                         | 1100 passed, 22 skipped                       |
| `pnpm build`                                                        | passes                                        |
| `migrate deploy` on a fresh database, `pnpm db:migrate:check`, seed | "No difference detected."; the seed completes |
| E2E flows                                                           | 7 of 7                                        |
| Visual suite, macOS                                                 | 21 of 21 (30 screenshots)                     |
| Visual suite, Linux container (arm64)                               | 21 of 21 (30 screenshots)                     |

The Linux visual run executes Playwright with the container image's own Node;
everything else ran on 24.21.0.

## Local data

The Postgres 16 volume (`wolff_postgres_data`) is left in place. The dev
database was moved to the new Postgres 17 volume with
`pg_dump -Fc | pg_restore --no-owner`, and migrations were applied on top.

## Verified on the deployed demo (2026-08-20)

Run against the free demo (Vercel Hobby, Neon, Redis Cloud, Upstash QStash,
Supabase Storage, Sentry, Stripe and Razorpay test mode, Gemini free tier)
from commits `8011d97` and `6c1748c`. Account-specific evidence (ids,
timestamps) is kept outside the repo.

- Demo login reaches the dashboard.
- A Stripe test-card payment on the client portal marks the invoice paid
  only once the `payment_intent.succeeded` webhook has been processed by
  the api's reconcile job.
- A partial refund (`charge.refunded`) moves the invoice to `partial`
  with the refunded amount due again.
- "Connect with Stripe" creates a Standard test connected account and an
  onboarding link; after onboarding with Stripe test data, `account.updated`
  turns on charges and payouts in the payment settings.
- Sentry receives an api error (a failed job answering 500) and a browser
  error from the web app. A server-side web error was not produced.
