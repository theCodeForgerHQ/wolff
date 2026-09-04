# Phase 1 baseline

Measured on 2026-07-16 on branch `phase0-baseline` (HEAD `1cfdd44`), before any
Phase 1 upgrade. Machine: macOS 15 (Darwin 24.6), Node 26.6.0 (the project
targets Node 24 via `.nvmrc`), pnpm 9.15.0, Postgres 16.15 in Docker.

## Checks

| Check        | Command                                                                                              | Result                                                                                                                                                                                                                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit tests   | `pnpm --filter @wolff/web exec vitest run --reporter=json`                                           | **989 tests** in 343 suites, 989 passed, 0 failed, 0 skipped                                                                                                                                                                                                                                  |
| Type check   | `pnpm type-check`                                                                                    | pass (6 turbo tasks)                                                                                                                                                                                                                                                                          |
| Lint         | `pnpm lint`                                                                                          | pass, 0 errors, 26 warnings (all "unused eslint-disable directive")                                                                                                                                                                                                                           |
| Build        | `pnpm build`                                                                                         | pass (Next 15.5.26, middleware 207 kB)                                                                                                                                                                                                                                                        |
| Schema drift | `prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma` | **not empty**: 86 lines (FK `onDelete` changes, 9 indexes the schema no longer declares, 2 nullability changes, `attachments.file_size` → `BIGINT`, `workspace_members.role` → `VARCHAR(20)`). The schema was changed upstream without a migration. Fixed by a catch-up migration in Phase 1. |

The `numTotalTests` figure is the one the Phase 1 DoD compares against.

## Dependency versions (installed)

| Package                 | Version                                 |
| ----------------------- | --------------------------------------- |
| next                    | 15.5.26                                 |
| react / react-dom       | 19.3.0                                  |
| typescript              | 5.9.3 (range `^5.7.0`)                  |
| zod                     | 3.25.76                                 |
| @hookform/resolvers     | 3.10.0                                  |
| prisma / @prisma/client | 6.19.3                                  |
| next-auth               | 5.0.0-beta.32                           |
| @auth/prisma-adapter    | 2.11.3                                  |
| stripe                  | 17.7.0, API version `2025-02-24.acacia` |
| tailwindcss             | 3.4.19                                  |
| vitest                  | 2.1.9                                   |
| @playwright/test        | 1.63.0 (range `^1.49.0`)                |
| eslint                  | 9.39.5                                  |
| Postgres (compose)      | 16 (`postgres:16-alpine`)               |
| Docker base image       | `node:20.18-alpine`                     |

## Visual baselines

`apps/web/e2e/visual/` holds a `toHaveScreenshot` suite
(`playwright.visual.config.ts`, `maxDiffPixelRatio: 0.01`) run against a
production build (`next start`) and a freshly seeded database. It covers 10 key
pages at 375, 768 and 1440 px wide (30 images):

| #   | Page                               | Why it's in the set                           |
| --- | ---------------------------------- | --------------------------------------------- |
| 01  | `/login`                           | first page every user sees; forms and buttons |
| 02  | `/register`                        | long form, validation layout                  |
| 03  | `/q/[token]` client portal quote   | what the paying client sees; branding         |
| 04  | `/i/[token]` client portal invoice | the payment entry point                       |
| 05  | `/dashboard`                       | cards, stats grid, lists, sidebar             |
| 06  | `/quotes`                          | data table, badges, filters                   |
| 07  | `/quotes/[id]`                     | document preview, detail cards                |
| 08  | `/invoices`                        | data table                                    |
| 09  | `/invoices/[id]`                   | document preview, payment status              |
| 10  | `/settings/payments`               | settings layout, Stripe Connect UI            |

Together they exercise the shadcn/ui primitives most exposed to the
Tailwind 4 changes (borders, rings, shadows, radii) and both layouts (public
and dashboard).

Baselines are stored per platform (`__screenshots__/darwin/…`), because
font rasterisation differs between macOS and Linux; the committed set was
captured on macOS. Linux baselines for CI come from the first CI run
(see `docs/phase-1.md`).

Masked regions, because they change between runs rather than between builds:
wall-clock text (greeting, today's date, relative times), the dashboard
activity feed, charts, toasts and the sticky demo banner. The detail and
portal pages use UUID clones of seeded documents (`e2e/visual/fixtures.ts`),
because the seed's readable ids can't be opened by the detail routes (see
below). The suite passed 3 consecutive runs with no diff before it was
committed.

How to run:

```bash
pnpm build
# The config starts `next start` on :3100 (TZ=UTC, trust-host set) itself.
DATABASE_URL=… pnpm --filter @wolff/web exec playwright test -c playwright.visual.config.ts
```

## Known issues found while measuring

1. **Seed ids are not UUIDs.** `demo-quote-*` / `demo-invoice-*` open as 404 on
   `/quotes/[id]`, `/invoices/[id]` and their edit routes, which validate a
   UUID. Left as-is: the deterministic demo seed is rebuilt in Phase 3.
2. **Two trust-host switches.** `lib/auth/index.ts` reads `TRUST_HOST`,
   `middleware.ts` reads `AUTH_TRUST_HOST`; `next start` on anything but
   Vercel needs both.
3. **Dashboard hydration mismatch.** React error #418 (text mismatch) on
   `/dashboard` raises the global "An unexpected error occurred." toast.
   Cause: Recent Activity's "N seconds ago" text differs between server
   and browser. Fixed in `2a21fd7` (Phase 4 re-review).
4. **Schema drift** (above).

## Deferred

- **Rename and rebrand** (Phase 1 task 1) is deferred: the product name is
  still undecided. Branding stays "Wolff" until it is chosen; the NOTICE/AGPL
  credit lands with the rename.
