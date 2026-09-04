# Phase 7: Polish and presentation

Branch `phase7-polish`, from tag `phase6-closed` (`749c638`). Nothing pushed.
Reviewed; the review's findings and their fixes are in
"Review findings and fixes" at the end. The tip before the fixes is tagged
`phase7-pre-review-fixes`. `v1.0.0-rc.1` points at the tip after the fixes;
`v1.0.0` waits for the rename and publication.

Hashes: the body of `e885c8a` (was `c65c86c`) was reworded during the review
fixes (message only; `git diff phase7-pre-review-fixes` of the reworded
history was empty). Every commit after it got a new hash: `b9d4855` →
`598d35c`, `403b0a6` → `a4e3325`, `d69d275` → `df4a640`, `10cb14f` →
`c132c6c`, `bf763cd` → `fbc660d`, `5073c18` → `d8992bf`, `a7e82a4` →
`f30f307`, `73a050f` → `a38ff94`. The new hashes are used below.

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
| `e885c8a`, `598d35c`            | chore: coverage tooling (Vitest v8 in every TS package, pytest-cov)                                                   |
| `a4e3325`                       | fix: example env files use compose's database password                                                                |
| `df4a640`, `f30f307`            | docs(readme): the README                                                                                              |
| `c132c6c`                       | fix(database): seed scripts read the root env files (fresh clone)                                                     |
| `fbc660d`                       | fix(api): ESLint globals for the k6 script                                                                            |
| `d8992bf`                       | fix(build): `NEXT_PUBLIC_*` passed through turbo to `next build`                                                      |

## Phase 7 criteria

| Criterion                                                         | State                       | Evidence                                                                                                                                             |
| ----------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADRs                                                              | Done                        | `docs/adr/0001`-`0008` and an index: free stack, QStash schedules, outbox, tenant guard, NIM + Groq, halfvec, parity port, encrypted logical backups |
| 3-minute video                                                    | **Not done**                | Needs the owner (voice, screen recording); listed below                                                                                              |
| README final                                                       | Done                        | `README.md`; every number from a phase doc or from this phase's runs below                                                                           |
| Lighthouse + web-vitals table                                     | Done                        | README tables; method and caveats below                                                                                                              |
| k6 load test, stated honestly                                     | Done, local only            | below                                                                                                                                                |
| Coverage badges                                                   | Numbers, no badges          | Badge services need the public GitHub repository and a CI run; the README has a table instead. Waits for the repository                              |
| `v1.0.0`                                                          | `v1.0.0-rc.1` locally       | `v1.0.0` after the rename and publication (owner decision)                                                                                           |
| Fresh clone runs from the README in < 15 min on a clean Codespace | Met on a Mac, cold, 3.5 min | Not a Codespace (none available); below                                                                                                              |
| CI green                                                          | **Not possible yet**        | The repository is not on GitHub, so CI has never run. Its jobs' steps were emulated locally only (checks table); that is not a CI run                |

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
iad1, so TTFB does not measure the server here (not investigated); the README
leaves it out.

LCP and FCP have the same p75 in the second run. Checked in the raw beacons
(`vlog2.json`): 24 of 29 LCP values exactly equal an FCP value (23 of 29 in
the first run), so on most loads the largest element is painted in the first
contentful paint (server-rendered pages, no hero image). The beacons carry no
page-load id that pairs the two metrics reliably, so this is a distribution
match, not a per-load proof.

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
get 429, which is what the 932 failures in run 3 most likely are (inferred from the code; that run did not record which limiter answered) (run 3 predates `e7570a8`,
which changes only aborted requests). Run 2's latency differs from run 1's on
the same code; the machine was not otherwise idle (not controlled).

**After the review fixes** (`4524d0d`, `30dfea3`, `3b06508`), with Redis
(`LOADTEST_REDIS_URL`, a scratch `redis:7-alpine`), at `30dfea3` (later commits
change no API code): two runs a few minutes apart, same stages (10/s start; 30 s
ramp and 60 s hold at 50, 100, 200 and 400/s).

| Run | Requests | p50     | p95      | p99      | Failed           | Dropped | `http_req_failed` < 1% | clients p95 < 500 ms |
| --- | -------- | ------- | -------- | -------- | ---------------- | ------- | ---------------------- | -------------------- |
| A   | 61,505   | 6.44 ms | 101.3 ms | 265.6 ms | 714 (1.16%), 429 | 144     | **fail**               | pass (84 ms)         |
| B   | 61,630   | 6.09 ms | 19.2 ms  | 61.2 ms  | 12 (0.01%), 429  | 19      | pass                   | pass (17 ms)         |

Run B logged which limiter answered each 429 (`3b06508`; a per-key 429 has
`RateLimit-Policy`, checked on both limiters): all 12 were the failed-auth
limiter, all in one second at 400/s (max latency 878 ms). Run A had no such
logging; its attribution is inferred. During run A's first two minutes a few
short Vitest runs shared the CPU. n = 2 with a 60× spread in failures: no
single number describes this machine. The p50 includes fast 429s.

The remaining trade-off: the slot is held only until the key check passes
(`30dfea3`), but more than 30 requests from one address whose key checks
overlap still get 429. Under load the key check slows, overlaps grow, and
that is what run A and B's failures are.

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
| web         | 1,264           | 15.2%      | 12.7%        | 15.4% |
| api         | 465             | 89.0%      | 82.0%        | 90.5% |
| core        | 360             | 90.2%      | 81.3%        | 93.4% |
| jobs        | 117 + 1 skipped | 90.3%      | 75.7%        | 92.8% |
| database    | 42              | 90.0%      | 85.9%        | 88.9% |
| contracts   | 18              | 14.4%      | 0%           | 13.9% |
| widget      | 12              | 83.2%      | 66.7%        | 86.3% |
| ai (Python) | 234 + 1 skipped | 94%        | not measured |       |

Numbers above are from the post-review run at `4ebb04d` (the jobs, database,
contracts, widget and ai rows did not change). The design asks for ≥ 90% lines
on `packages/core`: **met after the review fixes, 93.4%** (76.0% before). The
new core tests run against Postgres and were mutation-checked: for each file,
deliberate bugs (35 in all) were introduced one at a time and each turned a
test red. Writing them found two real bugs, fixed in their own commits
(`0a0e0e7` stage reorder, `7350c45` automation paging). Web's
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
- **Responsive** (`7718323`, `e8e314c`): checked at 320, 375, 768, 1024, 1440, 1920. Asserted by `responsive.spec.ts`: 7 dashboard pages here, 8 after the
  review (settings added, `018b8cf`), and since `0527e45` the content area
  (`<main>`) as well as the document. The 2 auth pages and both portal pages
  were checked once by a script during the build, not by the spec. Before: every
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
  in the visual baselines. Corrected in review (`ccf26bb`): amounts with no
  exchange rate were added unconverted; they are now left out and named, and
  the caption says when fallback rates were used.

## Fresh clone

**Cold run after the review** (finding 3), `/tmp/p7cold/run.sh` following the
README quick start literally, on a `git clone` of the local repository at
`4ebb04d`, Node 24.21.0, an empty pnpm store (`npm_config_store_dir`) and an
empty cache directory (`XDG_CACHE_HOME`, which also holds SWC's and Prisma's
caches):

| Step (cumulative)                              | Elapsed   |
| ---------------------------------------------- | --------- |
| clone                                          | 2 s       |
| `pnpm install` (cold store, 1.5 GB)            | 85 s      |
| `docker compose up -d postgres redis mailpit`  | 86 s      |
| env files, `NEXTAUTH_SECRET`                   | 86 s      |
| `db:generate`, `db:migrate:deploy`             | 96 s      |
| `db:seed`, `seed:demo`                         | 107 s     |
| `next dev` answers `/login`                    | 122 s     |
| signed in as the demo user, dashboard rendered | **133 s** |

- **Images:** cached for that run. Measured separately: pulling the three
  images into an empty Docker-in-Docker daemon took 79 s (763 MB unpacked),
  while the install was running. Total, cold: about 212 s, **3.5 minutes**,
  well under 15.
- **No README step failed.** The dev stack's containers (fixed names, same
  ports) were renamed and stopped for the run so the README's own
  `docker compose up` ran unchanged under its default project; they were
  restored afterwards.
- A first attempt failed in `next dev` because of the harness, not the README:
  `XDG_CACHE_HOME` pointed at `/tmp/...`, a symlink on macOS, and SWC refuses
  a cache root behind a symlink. Rerun from scratch with `/private/tmp`.
- **Deviations:** an Apple M1 Mac on a fast connection, not a Codespace; the
  clone is from the local repository, not GitHub.

The build-time run (at `c132c6c`, warm caches, existing containers) took
119 s; its first attempt had found the two README problems fixed in
`c132c6c` and `a4e3325`.

## Checks

**After the review fixes**: clean worktree at `4ebb04d` (the last code commit;
later commits are a darwin baseline and docs), no `.env` files, Node 24.21.0,
`pnpm install --frozen-lockfile`, turbo with `--force`, a fresh database per
suite (`/tmp/p7final.sh`). CI itself has never run: the repository is not on
GitHub, so these are its jobs' steps emulated locally, not a CI run.

| Check                                              | Result                                                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| type-check                                         | 14/14 tasks                                                                                           |
| lint                                               | 14/14 tasks, 0 errors (web 56, widget 2 warnings, pre-existing)                                       |
| build                                              | 4/4 tasks                                                                                             |
| `migrate:check` on a fresh migrated database       | "No difference detected."                                                                             |
| root tests (Postgres, stripe-mock, Testcontainers) | 11/11 tasks: web 1,264, api 465, core 360, jobs 117 + 1 skipped, database 42, contracts 18, widget 12 |
| coverage, `--concurrency=1`                        | 11/11 tasks; numbers in "Coverage"                                                                    |
| ai: ruff, ruff format, mypy                        | clean                                                                                                 |
| ai: pytest (`--cov=app`), isolation                | 234 passed, 1 skipped (94%); isolation 12 passed                                                      |
| E2E flows + setup + product + widget, Chromium     | 49 passed                                                                                             |
| same, Firefox / WebKit                             | 48 passed, 1 skipped (CDP perf spec) each                                                             |
| E2E assistant (web + api + ai, offline model)      | 2 passed                                                                                              |
| Visual, linux (`playwright:v1.63.0-noble`)         | 21/21                                                                                                 |
| Visual, darwin                                     | 1 failed, then 21/21 three times after `6c1204b` (below)                                              |

Two harness problems on the way, both mine and both fixed in the harness:
E2E first ran on an empty database (the seeding helper ran from `apps/web`,
where the migrate script does not exist), and then quote-to-paid failed in
Chromium and Firefox because the `test` and `coverage` steps had rebuilt the
web app without the publishable key (see "Known issues"). Rebuilt with the
key, all three browsers passed. Darwin visual failed the 375 px dashboard in
every full run: `f766bc5` had recorded that image from a filtered run, in
which the portal tests had not yet added activity. Re-recorded from a full
run in `6c1204b`.

**Before the review** (build-time run): clean worktree at `d8992bf` (was
`5073c18`), same method. All rows passed; E2E Chromium 48, Firefox and WebKit
47 + 1 skipped, assistant 2, visual 21/21 on both platforms (at `fbc660d`).
The first E2E run there failed quote-to-paid in all three browsers: the build
ran through turbo, which dropped `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (fixed
in `d8992bf`).

Mid-history commits that fail a check (history not rewritten):

- `4f78457` to `e8e314c`: the visual suite fails until the baselines are
  re-recorded in `635818e` (layout changes).
- `f02630e` to before `fbc660d`: `pnpm lint` fails in apps/api (k6 globals).
- `8506e40`: the failed-auth limiter can be bypassed by a parallel burst
  (fixed in `8679e34`); `8679e34`: by aborted requests (fixed in `e7570a8`).
- `0527e45`: the visual suite fails (one image, the 375 px dashboard) until
  the baselines are re-recorded in `f766bc5`; on darwin, in a full run, until
  `6c1204b`.
- E2E failed from the start of the phase until `d8992bf` (was `5073c18`) in
  every browser: the build ran through turbo, which dropped
  `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, so quote-to-paid had no Pay button.
  CI builds the same way, so it would have failed there too.

## Deployed

`scripts/deploy.sh bf763cd api,web` (`bf763cd` is now `fbc660d`): api `wolff-qf92tsvg8` deploy 77.8 s, smoke 2.5 s;
web `wolff-qf9uqs1ik` deploy 89.3 s, smoke 3.5 s; no rollback. ai unchanged
(only a dev dependency changed). No env vars changed.

The review fixes are **not deployed**: the live demo runs `fbc660d`'s api and
web. Redeploy with `scripts/deploy.sh <tip> api,web` and its smoke test when
the owner wants the fixes live; the README's web-vitals and Lighthouse
numbers are from that earlier deployment.

## Known issues and deferred

- Lighthouse mobile LCP 3.9-5.3 s (dashboard JavaScript).
- More than 30 requests from one address whose key checks overlap get 429
  (failed-auth limiter trade-off; a slow endpoint no longer counts since
  `30dfea3`).
- `createQuoteFromDeal` creates the quote and links the deal in two writes,
  not one transaction (seen while testing, not changed).
- Moderate axe findings and the "Beta" badge contrast (above).
- `turbo test` and `turbo lint` depend on `build`, so running them after a
  build made with `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` rebuilds the web app
  without it, and quote-to-paid then fails (no Pay button). Locally, build
  last before E2E; CI's e2e job already does (it runs no test step).
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

## Review findings and fixes

The peer review's findings, each verified by reading the code before
fixing. Each fix is its own commit, test first, red before and green after;
"bites" means the fix was reverted (or a mutant introduced) and the test went
red.

| #   | Severity | Finding                                                                                                        | Outcome                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | -------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | HIGH     | Failed-auth limiter untested on Redis; plain DECR after the window expires leaves -1 with no TTL               | **Fixed** `4524d0d`. Confirmed: rate-limit-redis 6.0.1 decrements with a plain DECR. Also found: a release after the window ended cancelled a failure counted in the next window. Now: no release once `resetTime` has passed, and a Lua DECR only on an existing counter above 0. New Testcontainers Redis suite (6 tests); each half bites on its own                                                     |
| 2   | HIGH     | Slot held for the whole request; more than 30 slow authenticated requests get 429                              | **Fixed** `30dfea3`: released the moment the secret or publishable key is accepted, once. Test: 45 overlapping 1.5 s requests, memory and Redis, both key kinds: 15 of 45 refused before, none after; burst and abort tests still pass. k6 rerun with Redis: see "Load test". Remaining: overlapping key checks                                                                                             |
| 3   | HIGH     | Fresh-clone criterion not measured cold                                                                        | **Done**: cold run 133 s plus a separate 79 s cold image pull, about 3.5 min, no README step failed (see "Fresh clone"). Mac, not a Codespace                                                                                                                                                                                                                                                               |
| 4   | MEDIUM   | A missing rate returns the amount unconverted while the caption says everything was converted at current rates | **Fixed** `ccf26bb`: left out of totals, named in the caption, "fallback exchange rates" when the static table was used. 7 new unit tests, red before                                                                                                                                                                                                                                                       |
| 5   | MEDIUM   | README k6 section                                                                                              | **Fixed**: the new runs' numbers, thresholds pass/fail per run, the real stages, the key's limit (100,000/min) and Redis store, the p50 caveat                                                                                                                                                                                                                                                              |
| 6   | MEDIUM   | README web-vitals table                                                                                        | **Fixed**: TTFB dropped with the reason; LCP = FCP investigated in the raw beacons (24 of 29 LCP values equal an FCP value); sample sizes and "scripted browsing" stated                                                                                                                                                                                                                                    |
| 7   | MEDIUM   | Core coverage 76% against 90%                                                                                  | **Fixed**: 93.4% lines (90.2% statements, 81.3% branches), 72 new core tests over the six files, mutation-checked (35 mutants, all caught). Found and fixed two real bugs: stage reorder (`0a0e0e7`), automation paging (`7350c45`). Badges wait for the GitHub repository                                                                                                                                  |
| 8   | MEDIUM   | phase-7 doc: E2E broken through the turbo build, CI emulated only                                              | **Fixed**: both stated ("Checks", criteria table)                                                                                                                                                                                                                                                                                                                                                           |
| 9   | LOW      | `c65c86c` body hides a mixed change                                                                            | **Fixed** by reword only: now `e885c8a`, subject and body name the jsdom bump; `git diff phase7-pre-review-fixes HEAD` was empty after the reword, author and committer dates unchanged                                                                                                                                                                                                              |
| 10  | LOW      | README visual coverage "7 pages"                                                                               | **Fixed**: "10 pages × 3 widths (30 images)"                                                                                                                                                                                                                                                                                                                                                                |
| 11  | LOW      | Responsive claim wider than `responsive.spec.ts`                                                               | **Fixed** `018b8cf`: `/settings` added (bites with a 1500 px child). While checking that it bites, found the spec could not see overflow inside `<main>` (itself a scroll container): `0527e45` measures `<main>` too, which found a real overflow on `/dashboard` at 320/375 px, fixed in the same commit (baselines `f766bc5`, darwin re-recorded in `6c1204b`). Claim narrowed for auth and portal pages |
| 12  | LOW      | Concurrent send: draft→sent unconditional                                                                      | **Fixed** `86384e4` (invoices): conditional update on the status read; only the winner renders the PDF and writes the event. Test: two concurrent sends, 2 events and 2 renders before, 1 after. The quote route had the same race: `a9deac1`, same test                                                                                                                                                    |
| 13  | LOW      | k6 429 attribution not evidence-based                                                                          | **Fixed** `3b06508`: the script records which limiter answered each 429; run B's 12 were all the failed-auth limiter. Run A's attribution is labelled as inferred                                                                                                                                                                                                                                           |

No finding was disputed.

Not changed, noted: `createQuoteFromDeal` writes the quote and the deal link
outside one transaction.
