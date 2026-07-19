# Phase 1: upgrades and foundation

Branch `phase1-upgrades`, 25 commits on top of `phase0-baseline` (`a1f6f4d`).
Phase 1 has a task list and a definition of done (DoD). The
starting point is recorded in [`docs/baseline.md`](baseline.md); the Stripe
analysis is in [`docs/upgrades/stripe.md`](upgrades/stripe.md).

## What changed

| Area           | Before                                  | After                                                                                          | Commit               |
| -------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------- |
| Baseline       | none                                    | `docs/baseline.md`, 30 screenshot baselines (10 pages × 375/768/1440) taken before any upgrade | `44fd76e`            |
| Schema drift   | `migrate diff` not empty                | catch-up migration; diff empty                                                                 | `3ed5745`            |
| Postgres       | 16 (`postgres:16-alpine`)               | 17.10 + pgvector 0.8.2 (`pgvector/pgvector:0.8.2-pg17`) in all compose files and CI            | `af39dbd`            |
| Docker runtime | `node:20.18-alpine`                     | `node:24-alpine`                                                                               | `6f2e2be`            |
| TypeScript     | `^5.7`                                  | `5.9.3` (exact); `@types/node` 24                                                              | `21dc45c`            |
| Zod            | 3.25                                    | 4.6.5, `@hookform/resolvers` 5.9                                                               | `2829898`            |
| Prisma         | 6.19 (Rust engine)                      | 7.10.0 exact: `prisma-client` generator, pg driver adapter, `prisma.config.ts`                 | `471eef5`            |
| Auth adapter   | `@auth/prisma-adapter`                  | Wolff-schema adapter inside the encryption wrapper (D10 fallback)                              | `4dccee2`            |
| Next.js        | 15.5.26, `middleware.ts`                | 16.3.7 exact, `proxy.ts`, Turbopack builds, flat ESLint config                                 | `cdebeb9`, `76d9fa6` |
| Tailwind       | 3.4 + `tailwind.config.ts`              | 4.3.3 CSS-first `@theme` via the official upgrade tool                                         | `194cafc`, `d67ed2a` |
| Stripe         | SDK 17.7, API `2025-02-24.acacia`       | SDK 22.6.2, API `2026-08-26.dahlia`                                                            | `f18c508`, `8fcbbfa` |
| Vitest         | 2.1                                     | 5.0.2 (+ Vite 8, plugin-react 6.1.1)                                                           | `bd77908`            |
| Playwright     | `^1.49` (resolved 1.63)                 | `1.63.0` exact                                                                                 | `e641656`            |
| Sentry         | none                                    | `@sentry/nextjs` 11.1.0, disabled unless a DSN is set                                          | `c96ebc5`            |
| E2E            | none for the DoD                        | login (credentials + mock Google OIDC), quote → invoice → Stripe payment                       | `34a6bd7`, `ef166ec` |
| CI             | lint, types, unit, build on Postgres 15 | + migrations check, DB/stripe-mock suites, E2E job, Postgres 17                                | `36fa31b`            |

Fixes that came out of the work, each in its own `fix:` commit:

- `236fbee` pino's `pino/file` transport crashed every logging route in
  `next dev` (`Cannot find module …/vendor-chunks/lib/worker.js`).
- `4dccee2` First-time Google/GitHub sign-in could never create a user:
  `@auth/prisma-adapter` writes the Auth.js reference schema, not Wolff's.
- `8fcbbfa` (from a security review of the Stripe commit) A refund that
  rounded to 0 cents was sent as a _full_ refund;
  Stripe ids, amounts, currency, email and metadata are now validated at the
  SDK boundary; the stripe-mock override accepts loopback hosts only.
- `a39d1ad` The portal's Pay button showed "online payment is not yet
  available" for every invoice since the portal redesign (`334c165`).

## Definition of done

### Test count ≥ baseline, all green

|                                                         | Baseline (`a1f6f4d`)  | Now                                               |
| ------------------------------------------------------- | --------------------- | ------------------------------------------------- |
| `vitest run` without services                           | 989 tests, 989 passed | **1052 tests: 1038 passed, 14 skipped, 0 failed** |
| with `TEST_DATABASE_URL` + `STRIPE_MOCK_URL` (as in CI) | n/a                   | **1052 passed, 0 skipped**                        |

The 14 skipped tests are the Postgres adapter integration tests (7) and the
stripe-mock contract tests (7); CI provides both services. New tests: auth
adapter mapping (4) and integration (7), Stripe webhook signatures (5),
stripe-mock contracts (7), Stripe input validation (22), loopback URL rule (8),
portal payment component (4), Sentry options (6).

Commands: `TEST_DATABASE_URL=… STRIPE_MOCK_URL=http://localhost:12111 npx turbo test`.

### `pnpm build` green

`pnpm build` passes (Next 16.3.7, Turbopack). `pnpm type-check` passes.
`pnpm lint` has 0 errors and 69 warnings (baseline: 0 and 26); the increase is
the React Compiler rules that eslint-config-next 16 brings in, see Known issues.
The Docker image builds and, run against Postgres 17, starts on Node 24.21 and
returns `{"status":"healthy","services":{"database":"connected"}}` from
`/api/health`.

### `prisma migrate diff` empty

`pnpm db:migrate:check` (`prisma migrate diff --from-migrations
prisma/migrations --to-schema prisma/schema.prisma --exit-code`) prints "No
difference detected." and exits 0 against Postgres 17. At baseline the same
comparison produced 86 lines of drift, fixed by `3ed5745`. CI's `migrations`
job runs `migrate deploy` → `migrate:check` → `db:seed` on a fresh database.

### Screenshot diffs within `maxDiffPixelRatio 0.01`, or a reviewed update

`playwright.visual.config.ts`: 10 pages × 3 widths = 30 screenshots in 21
Playwright tests. After every upgrade the suite was re-run on a fresh
database:

| Upgrade                                                | Result                                                                                                                                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres 17, Prisma 7, Next 16, Stripe, Vitest, Sentry | 30/30 within 0.01                                                                                                                                                                      |
| Tailwind 4                                             | 22/30 within 0.01 after three fixes (shadows, Label spacing, variant props); 8 updated in `d67ed2a`, which lists each remaining difference and why it is intended Tailwind 4 behaviour |

Every baseline set was confirmed stable with 2–3 consecutive runs before it
was committed.

### Playwright: login (credentials + mocked Google), quote → invoice → Stripe test payment

`playwright.flows.config.ts`, 6 tests, 2 consecutive green runs:

- credentials sign-in, wrong password, redirect of signed-out visitors;
- Google sign-in through `oauth2-mock-server` (discovery, PKCE, token
  exchange, id_token verification run for real): the user is created, the
  account linked, the access token stored encrypted (`enc:`), and a second
  sign-in reuses both;
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
  Wolff's schema (see `4dccee2`).
- **Prisma client module format.** The design implies the ESM `prisma-client`
  output; it is generated as CommonJS (`moduleFormat = "cjs"`) because
  Playwright and the tsx seed scripts load it through `require()` and the
  workspace packages aren't `"type": "module"`.
- **Middleware runtime.** The auth middleware moved to the Node.js runtime
  (`cdebeb9`) before the Next 16 upgrade, which then renamed it to `proxy.ts`.
- **Visual baselines are per platform.** The committed set is macOS; Linux
  baselines for CI are produced by the first CI run (see below).
- **Stripe testing uses stripe-mock** instead of Stripe test mode (no keys).

## Known issues and follow-ups

| Issue                                                                                                           | Status                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Seeded quotes and invoices have readable ids (`demo-quote-6`) that the UUID-only detail and edit routes reject  | Left for the Phase 3 deterministic seed; tests use UUID clones                                                                             |
| `lib/auth/index.ts` reads `TRUST_HOST`, `proxy.ts` reads `AUTH_TRUST_HOST`                                      | Both must be set for `next start` outside Vercel; unify later                                                                              |
| `/dashboard` hydration mismatch (React #418) raises the global error toast                                      | Seen at baseline; masked in the visual suite, not yet fixed                                                                                |
| 35 findings from eslint-plugin-react-hooks 7 (React Compiler rules: `set-state-in-effect`, `refs`, `purity`, …) | Set to `warn` in `eslint.config.mjs`; fix before enabling the React Compiler                                                               |
| Turbopack warns that `lib/services/storage.ts` and the PDF Chromium lookup trace the whole project              | Output size only; add `turbopackIgnore` or narrow the paths                                                                                |
| `app/opengraph-image.tsx` and `app/twitter-image.tsx` use the deprecated Edge runtime                           | Switch to the Node.js runtime                                                                                                              |
| Standard Connect accounts are charged with `transfer_data.destination`                                          | Pre-existing; revisit in the Phase 3 `PaymentProvider` work (`docs/upgrades/stripe.md`)                                                    |
| stripe-mock 0.205.0 may lag the newest API version                                                              | Contract tests catch request-shape breaks, not the newest response fields                                                                  |
| Linux visual baselines aren't committed                                                                         | The CI `e2e` job generates them with `--update-snapshots=missing` and uploads them; commit that artifact to make the Linux comparison real |
| next-auth is still `5.0.0-beta.32`                                                                              | Pinned exactly                                                                                                              |
| Local development ran on Node 26.6; the project targets Node 24                                                 | All checks pass on 26; CI and Docker use 24                                                                                                |

## Needs a person with accounts or keys

- **Stripe test account:** set the webhook endpoints' API version to
  `2026-08-26.dahlia`; run Connect onboarding, a real test-mode card payment
  through the Payment Element and a refund.
- **Google Cloud OAuth client:** one real Google sign-in to confirm the
  production provider config (the E2E uses a mock issuer).
- **Sentry project (Phase 2):** set `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN`,
  and `SENTRY_AUTH_TOKEN`/`SENTRY_ORG`/`SENTRY_PROJECT` for source maps.
- **CI:** the workflow has only been validated locally (actionlint 1.7.12,
  every job's commands run by hand). The first remote run also produces the
  Linux visual baselines.

## Local data

The Postgres 16 volume (`wolff_postgres_data`) is left in place. The dev
database was moved to the new Postgres 17 volume with
`pg_dump -Fc | pg_restore --no-owner`, and migrations were applied on top.
