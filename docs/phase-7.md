# Phase 7: Polish and presentation

Branch `phase7-polish`, from tag `phase6-closed` (`749c638`). Nothing pushed.
Not yet reviewed: the review, its fixes and the closing gate
are still to come. Tagged `v1.0.0-rc.1` locally; `v1.0.0` waits for the
rename and publication.

## Commits

| Commit                          | What                                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `bee3fa4`                       | fix(jobs): a send already in flight with the same Resend key is the same send (concurrent sends no longer answer 502) |
| `4f78457`                       | fix(web): pipeline totals converted; dashboard caption names the currency and the converted ones                      |
| `844e650`                       | docs(adr): eight ADRs                                                                                                 |
| `47ed5fa`                       | fix(web): demo banner under the header, not over it                                                                   |
| `14062f2`                       | test(e2e): Firefox and WebKit runs (`E2E_BROWSER`)                                                                    |
| `7c9e627`                       | fix(web): sidebar hydration failure (React #418) on phone-sized screens                                               |
| `7718323`                       | fix(web): no horizontal overflow from 320 to 1920 px                                                                  |
| `bc273c6`                       | fix(web): serious and critical axe findings on the main pages                                                         |
| `d88add8`                       | fix(web): compact empty revenue chart (design review)                                                                 |
| `e8e314c`                       | fix(web): wrapping table toolbar; settings sections as a select below lg                                              |
| `635818e`                       | test(visual): baselines re-recorded, darwin and linux                                                                 |
| `8506e40`, `8679e34`, `e7570a8` | fix(api): failed-authentication limiter (see "Load test")                                                             |
| `f02630e`                       | test(api): k6 load test                                                                                               |
| `c65c86c`, `b9d4855`            | chore: coverage tooling (Vitest v8 in every TS package, pytest-cov)                                                   |
| `403b0a6`                       | fix: example env files use compose's database password                                                                |
| `d69d275`, `a7e82a4`            | docs(readme): the README                                                                                              |
| `10cb14f`                       | fix(database): seed scripts read the root env files (fresh clone)                                                     |
| `bf763cd`                       | fix(api): ESLint globals for the k6 script                                                                            |
| `5073c18`                       | fix(build): `NEXT_PUBLIC_*` passed through turbo to `next build`                                                      |

## Phase 7 criteria

| Criterion                                                         | State                        | Evidence                                                                                                                                             |
| ----------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADRs                                                              | Done                         | `docs/adr/0001`-`0008` and an index: free stack, QStash schedules, outbox, tenant guard, NIM + Groq, halfvec, parity port, encrypted logical backups |
| 3-minute video                                                    | **Not done**                 | Needs the owner (voice, screen recording); listed below                                                                                              |
| README final                                                       | Done                         | `README.md`; every number from a phase doc or from this phase's runs below                                                                           |
| Lighthouse + web-vitals table                                     | Done                         | README tables; method and caveats below                                                                                                              |
| k6 load test, stated honestly                                     | Done, local only             | below                                                                                                                                                |
| Coverage badges                                                   | Numbers, no badges           | Badge services need a public repository and CI; the README has a table instead                                                                       |
| `v1.0.0`                                                          | `v1.0.0-rc.1` locally        | `v1.0.0` after the rename and publication (owner decision)                                                                                           |
| Fresh clone runs from the README in < 15 min on a clean Codespace | Met locally, with deviations | below                                                                                                                                                |
| CI green                                                          | **Not possible yet**         | The repository is not on GitHub. Every CI job's steps were run locally (checks table)                                                                |

## Web vitals

Method: `vercel logs wolff-web.vercel.app --json` streamed (the CLI only shows
new logs, 5 minutes at a time, restarted in a loop) while a Playwright script
browsed the live demo with the protection-bypass header, signed in as the demo
user: 8 pages (`/dashboard`, `/quotes`, `/invoices`, `/clients`, `/leads`,
`/deals`, `/dashboard/analytics`, `/settings`) × 4 rounds, desktop 1440 px then
an emulated Pixel 7, one click and one Tab per page for INP. The `web-vital`
log lines were de-duplicated by (id, metric) and summarised with
`summariseVitals` / `toMarkdownTable` from `apps/web/lib/observability/web-vitals.ts`.

| Metric | Previous deployment (`wolff-9kvxxrofy`), 196 samples | This release (`wolff-qf9uqs1ik`), 134 samples |
| ------ | ---------------------------------------------------- | --------------------------------------------- |
| LCP    | 1,556 ms (28)                                        | 856 ms (27)                                   |
| INP    | 48 ms (25)                                           | 8 ms (16)                                     |
| CLS    | 0.001 (41)                                           | 0.001 (21)                                    |
| FCP    | 1,244 ms (39)                                        | 856 ms (27)                                   |
| TTFB   | 71 ms (35)                                           | 54 ms (22)                                    |
| FID    | 7 ms (28)                                            | 4 ms (21)                                     |

Same script both times; not every page load delivers every metric (beacons
lost on navigation), hence the uneven counts. The difference between the two
runs was not analysed and should not be read as an improvement from this
phase's changes. Most TTFB samples (38-56 ms) are below the round trip to
iad1, so TTFB does not measure the server here (not investigated).

## Lighthouse

Lighthouse 12 (`npx lighthouse@12`), Playwright's Chromium, headless,
`--extra-headers` with the bypass header and the demo session cookie; mobile
default profile and `--preset=desktop`; one run per page on the deployment of
this release. Table in the README. A first run on the previous deployment was
made while the Firefox E2E suite was running on the same CPU and scored mobile
43-53 (desktop 79-96); it is not used. Accessibility: the only failing audit
left is colour contrast of the header's "Beta" badge (not fixed).

## Load test (k6)

`apps/api/scripts/loadtest.sh` (fixed Schemathesis seed and key, API in
production mode under `tsx`, no Redis, k6 1.3.0 in Docker), all on one Apple M1
with 8 GB. Offered load 10 → 50 → 100 → 200 → 400 requests/s (ramping arrival
rate, 6 min), 40% client list, 40% invoice list, 20% one invoice; small dataset
(the parity workspace).

| Run          | Code             | Requests | p50     | p95     | p99      | Failed                           |
| ------------ | ---------------- | -------- | ------- | ------- | -------- | -------------------------------- |
| 1 (to 200/s) | before `8506e40` | 28,650   | 4.97 ms | 11.0 ms | 24.9 ms  | 4 (429)                          |
| 2 (to 200/s) | same             | 28,572   | 5.85 ms | 68.1 ms | 408.6 ms | 1,290 (429)                      |
| 3 (to 400/s) | `8679e34`        | 61,600   | 3.92 ms | 14.2 ms | 172.8 ms | 932 (429), 50 dropped iterations |

Every failure was a 429 from the failed-authentication limiter, not an error.
Its first implementation (express-rate-limit `skipSuccessfulRequests`) counts
requests in flight. `8506e40` changed it to count only finished 401s; the
coordinator's review found that this let a parallel burst of bad keys bypass
the 30-a-minute limit, so `8679e34` reserves a slot on arrival and gives it back
for a finished non-401 response, and `e7570a8` keeps the slot when the client
aborts. The accepted cost: more than 30 requests in flight from one address
get 429, which is what the 932 failures in run 3 are (run 3 predates `e7570a8`,
which changes only aborted requests). Run 2's latency differs from run 1's on
the same code; the machine was not otherwise idle (not controlled).

What this shows: the read path is cheap on a small dataset on one laptop. What
it does not show: capacity of the deployed demo (Vercel functions, Neon over
the network), behaviour with production-sized data, or writes. No scale claim
is made. The free demo was never load-tested, on purpose.

## Coverage

`turbo test:coverage --force --concurrency=1` with Postgres and stripe-mock
(Testcontainers for Redis and S3), every source file counted; `pytest
--cov=app` with the AI test database.

| Package     | Tests           | Statements | Branches     | Lines |
| ----------- | --------------- | ---------- | ------------ | ----- |
| web         | 1,255           | 15.0%      | 12.6%        | 15.3% |
| api         | 451             | 88.9%      | 81.6%        | 90.4% |
| core        | 288             | 72.5%      | 65.1%        | 76.0% |
| jobs        | 117 + 1 skipped | 90.3%      | 75.7%        | 92.8% |
| database    | 42              | 90.0%      | 85.9%        | 88.9% |
| contracts   | 18              | 14.4%      | 0%           | 13.9% |
| widget      | 12              | 83.2%      | 66.7%        | 86.3% |
| ai (Python) | 234 + 1 skipped | 94%        | not measured |       |

The design asks for ≥ 90% lines on `packages/core`: **not met (76.0%)**. Web's
15% is low because every component counts and the UI is covered by E2E, not
unit tests. With all packages in parallel, two core tests timed out under
coverage instrumentation (5 s limit); sequentially, all pass.

## Frontend quality pass

- **Demo banner** (`47ed5fa`): in the page flow under the header. New spec at
  375 and 1440 px: no overlap, Notifications opens (red before, green after).
- **Firefox and WebKit** (`14062f2`): `E2E_BROWSER`. The widget perf spec uses
  CDP and skips outside Chromium.
- **Hydration** (`7c9e627`): found by the axe pass (an error toast at 375 px):
  every dashboard page failed hydration below 768 px, and each mobile user saw
  "An unexpected error occurred." Spec red on 3 pages before, green after.
- **Responsive** (`7718323`, `e8e314c`): checked at 320, 375, 768, 1024, 1440,
  1920 on 7 dashboard pages, 2 auth pages and both portal pages. Before: every
  dashboard page overflowed at 768 (34-264 px), most at 1024, `/deals` at 1440;
  the old 768 baselines were 802-1032 px wide. After: none. Spec red with the
  fix reverted.
- **axe** (`bc273c6`): 7 pages × 375/1440, serious and critical: before, 2-3
  critical and up to 7 serious per page; after, none (14 tests). Remaining,
  not asserted: moderate `heading-order` (/leads), `page-has-heading-one`
  (/settings, invoice detail without a title), and the portal amount in the
  workspace's brand colour (contrast set by the workspace).
- **Design review** against the project's design checklist, restrained: the
  empty revenue chart (largest dead area on the dashboard) made compact
  (`d88add8`); toolbar wrap and settings layout (`e8e314c`). Seen, not changed:
  the summary row's cards stretch to the tallest card; empty Kanban columns
  have no hint; the header's "Beta" badge contrast.
- **Visual baselines** (`635818e`): 18 of 30 images per platform changed,
  opened before recording; measured diffs 8-18% (details in the commit).
  Darwin 21/21 three times in a row; linux 21/21 in
  `mcr.microsoft.com/playwright:v1.63.0-noble`.

Not done in this pass: visual checks in Firefox and WebKit at every width
(the E2E flows ran in both; the width checks ran in Chromium).

## Leftovers from earlier phases

- **Concurrent sends answered 502** (`bee3fa4`): Resend answers the second
  request with the same key 409 `concurrent_idempotent_requests`; the transport
  now waits (250-2,000 ms) and asks again, getting the first one's result. Test
  red before. Verified against a stub server only, not live Resend.
- **Mixed-currency dashboard** (`4f78457`): pipeline totals converted to the
  base currency; caption under the stats ("Amounts in INR. EUR and USD amounts
  are converted at current exchange rates."). Unit tests only; the caption is
  in the visual baselines.

## Fresh clone

`/tmp/p7/fresh/run.sh` followed the README quick start literally on a `git
clone` of the local repository at `10cb14f`, Node 24.21.0:

| Step                                           | Elapsed   |
| ---------------------------------------------- | --------- |
| clone                                          | 3 s       |
| `pnpm install`                                 | 21 s      |
| generate, migrate, `db:seed`, `seed:demo`      | 44 s      |
| `next dev` answers `/login`                    | 77 s      |
| signed in as the demo user, dashboard rendered | **119 s** |

Deviations, recorded:

1. **No Codespace** (none available): run on the development Mac.
2. **Warm caches**: the pnpm store and Docker images were already present. A
   separate cold install (`--store-dir` empty) took 2 min 42 s and 1.5 GB; the
   Docker image pull was not measured. Estimated cold total: well under 15
   minutes, but that total was not measured in one run.
3. **Compose services already running**: `docker compose up -d` failed on the
   fixed container names (`wolff-postgres` in use), so the running containers
   (same images) were used, with a fresh database `fresh_clone` instead of
   `wolff`.

The first attempt failed: `db:seed` could not read `DATABASE_URL` (fixed in
`10cb14f`), and the example env files had the wrong database password (fixed in
`403b0a6`).

## Checks

Clean worktree at `5073c18` (later commits are docs only), no `.env` files,
Node 24.21.0, `pnpm install --frozen-lockfile`, turbo with `--force`.

| Check                                                    | Result                                                                                                |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| type-check                                               | 14/14 tasks                                                                                           |
| lint                                                     | 14/14 tasks, 0 errors (web 56, widget 2 warnings, pre-existing)                                       |
| build                                                    | 4/4 tasks                                                                                             |
| `migrate:check` on a fresh migrated database             | "No difference detected."                                                                             |
| root `pnpm test` (Postgres, stripe-mock, Testcontainers) | 11/11 tasks: web 1,255, api 451, core 288, jobs 117 + 1 skipped, database 42, contracts 18, widget 12 |
| ai: ruff, ruff format, mypy                              | clean; 81 files formatted; 77 source files                                                            |
| ai: pytest (AI test database)                            | 234 passed, 1 skipped; isolation 12 passed                                                            |
| E2E flows + setup + product + widget, Chromium           | 48 passed                                                                                             |
| same, Firefox                                            | 47 passed, 1 skipped (CDP perf spec)                                                                  |
| same, WebKit                                             | 47 passed, 1 skipped                                                                                  |
| E2E assistant (web + api + ai, offline model)            | 2 passed (at `bf763cd`)                                                                               |
| Visual, darwin / linux                                   | 21/21 / 21/21 (at `bf763cd`)                                                                          |

The first E2E run at `bf763cd` failed quote-to-paid in all three browsers: the
build ran through turbo, which dropped `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, so
the portal had no Pay button (fixed in `5073c18`; CI builds the same way and
would have failed). The type-check, lint and test rows are from `bf763cd`; the
only later code change is `turbo.json`.

Mid-history commits that fail a check (history not rewritten):

- `4f78457` to `e8e314c`: the visual suite fails until the baselines are
  re-recorded in `635818e` (layout changes).
- `f02630e` to before `bf763cd`: `pnpm lint` fails in apps/api (k6 globals).
- `8506e40`: the failed-auth limiter can be bypassed by a parallel burst
  (fixed in `8679e34`); `8679e34`: by aborted requests (fixed in `e7570a8`).

## Deployed

`scripts/deploy.sh bf763cd api,web`: api `wolff-qf92tsvg8` deploy 77.8 s, smoke 2.5 s;
web `wolff-qf9uqs1ik` deploy 89.3 s, smoke 3.5 s; no rollback. ai unchanged
(only a dev dependency changed). No env vars changed.

## Known issues and deferred

- `packages/core` line coverage 76%, below the design's 90%.
- Lighthouse mobile LCP 3.9-5.3 s (dashboard JavaScript).
- More than 30 in-flight requests from one address get 429 (failed-auth
  limiter trade-off).
- Moderate axe findings and the "Beta" badge contrast (above).
- The README's quick start relies on `sed -i.bak` (works on macOS and GNU sed);
  Windows was not tried.
- Delete the Next `/api/v1` routes on or after 2026-09-01 (phase-6b).
- Leftover scratch databases from earlier phases on `wolff-postgres`
  (`fx_*`, `fxck_*`, `wolff_e2e_g`, …) were left in place; this phase's own
  (`p7_*`) were dropped.

## Needs the owner

1. The 3-minute video and the 30-second GIF the README structure asks for.
2. The rename to Wolff, then `v1.0.0`, the GitHub repository, and a first CI
   run on GitHub (the coverage badges need it too).
3. Optional: a run of the fresh-clone check in a Codespace once the repository
   exists.
