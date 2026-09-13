# Features

One entry per shipped feature: what we built, how it works, and what it changed
architecturally. Written **after** building. Newest last.

Read alongside `DECISIONS.md` and you have the full history — every significant choice, and
everything built as a result.

**Template**

```
## YYYY-MM-DD — <feature name>
**What:** one or two sentences on what now exists.
**How:** the mechanism. Files, tables, functions touched.
**Architecture impact:** what this changes for anything built on top of it. "None" is a valid
answer, but say it.
**Verified by:** the test or check that proves it works.
**By:** <human> + <agent>
```

---

## 2026-09-05 — Indicator formulas verified against TradingView
**What:** RSI(14), EMA(21) and SMA(50/200) confirmed to match TradingView's Pine definitions.
Five golden values recorded for Micron.
**How:** three independent implementations compared — production SQL over full history, a Python
reference implementing `ta.rma` / `ta.ema` / `ta.sma` directly, and pandas `ewm` as a third code
path. Agreement to 1x10^-6 across *different windows and different seeding*, which is stronger
evidence than two runs of the same code. Wilder-vs-simple RSI and EMA seed sensitivity were both
quantified rather than assumed.
**Architecture impact:** fixes Wilder smoothing as non-negotiable, and establishes warm-up floors
that every future recursive indicator must respect.
**Verified by:** the five figures in `DEFINITIONS.md` section 6. **Not yet committed as test
fixtures** — that lands with the test harness.
**By:** Bodhi + Claude

## 2026-09-12 — Repository scaffold
**What:** the repo skeleton — context files, config, CI, skills, hard-stop settings.
**How:** `CLAUDE.md` as the always-read guardrail index; `docs/` for the narrative files;
`config/watchlist.yml` and `config/norms.yml` so the two things we tune most are data, not code;
`.gitignore` written before the first commit because the repo is public.
**Architecture impact:** establishes that watchlist and norms are edited as config. Anything
reading them must read the files, never hardcode.
**Verified by:** `make context` runs; `git status` clean after the initial commit.
**By:** Bodhi + Claude

## 2026-09-12 — Onboarding path, code map and comment discipline
**What:** `docs/ONBOARDING.md`, `docs/CODEMAP.md`, `docs/CODE_STYLE.md`, plus a coarser theme
structure in `config/watchlist.yml`.
**How:** ONBOARDING gives a sequenced read order with time boxes, a six-question comprehension
check, and the five mistakes new sessions repeat. CODEMAP carries the data-flow diagram, a
"where do I start reading for question X" table, and five invariants meant to outlive refactors.
CODE_STYLE mandates why-not-what comments and purpose headers, with good/bad examples on the
three live traps (the weekly join, Wilder smoothing, `rows` vs `range`). Watchlist gained a
coarse `theme` for ranking and a granular `tag` for display.
**Architecture impact:** two new CI gates — a `rankable: true` theme must have 3+ members, and
every migration must open with a 3-line purpose header. Both fail the build rather than asking.
**Verified by:** config validation run locally (36 tickers, 7 themes, 24 rankable, no undeclared
themes); all `CLAUDE.md` cross-references resolve.
**By:** Bodhi + Claude

## 2026-09-12 — Change hygiene, setup guide, and a tightened foundation
**What:** `docs/HYGIENE.md` (the canonical change matrix, commit format, concurrent-session
rules, definition of done) and `docs/SETUP.md` (one-time account wiring, per-contributor steps).
Every duplicated "what to update" list now points at HYGIENE instead.
**How:** CI `hygiene` job enforces the matrix precisely — code → FEATURES/INCIDENTS, norm →
DECISIONS, theme structure → DECISIONS, unique decision numbers — and warns on a new doc missing
from `CLAUDE.md`'s table. Commit trailers carry the agent and session URL so `git blame` means
something with five sessions. A false claim in `DEFINITIONS.md` (golden values "committed as
fixtures") corrected to "will be, when the harness lands".
**Architecture impact:** HYGIENE is now the single source for process rules. Changing a rule
means changing one file.
**Verified by:** `ci.yml` parses; all `CLAUDE.md` pointers resolve; config gate passes locally.
**By:** Bodhi + Claude

## 2026-09-12 — Foundation migration: extensions, watchlist cache, raw bars, ingest log
**What:** `supabase/migrations/20260912120000_foundation.sql` — `pg_net` + `pg_cron`,
`tickers`, `daily_bars`, `hourly_bars`, `ingest_runs`. RLS on all four, no policies (deny by
default). Default anon/authenticated privileges revoked so nothing is reachable until granted.
**How:** applied by the Supabase GitHub integration on merge to `main` (decision 0016).
`tickers` is a cache of `config/watchlist.yml`, overwritten by the nightly sync — the yml stays
the source of truth. Every bar row carries `source` so a provider swap is auditable.
**Architecture impact:** establishes the timestamp migration naming, the deny-by-default
posture, and `ingest_runs` as the observability surface every fetcher must write to.
**Verified by:** parsed with libpg_query (17 statements, clean). Applied-state check after
merge: four tables with `rowsecurity = true`, two extensions, zero anon default privileges.
**By:** Bodhi + Claude

## 2026-09-12 — Ingest edge function: watchlist sync, daily and hourly bars
**What:** `supabase/functions/ingest/` — reads `config/watchlist.yml` from the public repo,
syncs `tickers`, pulls daily bars (indices included) and hourly bars (tickers only) from Yahoo,
writes one `ingest_runs` row per call. Provider seam in `provider.ts` (decision 0003), Yahoo
implementation in `yahoo.ts`, watchlist reader in `watchlist.ts`, fixture tests in
`ingest_test.ts`. New CI job `Edge function tests` runs them and type-checks every entry point.
**How:** `?scope=tickers|daily|hourly|all`, `?symbols=`, `?full=1`, `?limit=N`, `?by=`. Bearer
must equal the service_role key (decision 0017). A symbol with no bars gets `range=max` /
`range=2y` automatically, capped at `limit` full fetches per run (default 8) with the rest listed
in `deferred` — so a first backfill is several calls, each idempotent. Removed symbols are
deactivated. Daily rows carry `adj_close` only when Yahoo supplies it; never copied from close.
**Architecture impact:** fixes the shape every future fetcher follows — a run row opened first,
per-symbol errors recorded not thrown, `source` on every row. The scheduling migration (pg_cron
→ pg_net → this function, key from Vault) is the next PR; nothing runs on a clock yet.
**Verified by:** 11 fixture tests pass locally (null close dropped, adj_close never substituted,
`chart.error` and missing timestamps both fail loudly, later bar wins on a duplicate date,
undeclared theme rejected); `deno check` clean against supabase-js 2.116; real `watchlist.yml`
parses to 36 tickers + 5 indices, 24 rankable, 7 themes — matching `make context`. Live
behaviour (Yahoo from Supabase egress, wall-clock per call) is verified after deploy and logged
here in a follow-up line.
**Live (2026-09-13):** deploy-on-merge for functions confirmed (CONSTRAINTS.md). Two runtime
bugs found by calling it, both logged in INCIDENTS.md: a 401 on a genuine service_role key (auth
moved to `auth.ts` — role claim of the gateway-verified JWT, or byte match), then a 500 on
`permission denied` (migration `20260913003000_service_role_grants`, decision 0018).
First successful run 2026-09-13 00:33: `ok: true`, 41 tickers synced (24 rankable, matching
`make context`), 15,100 rows in **6.9 s**, zero per-symbol errors. Hourly verified correct —
3,484 bars per symbol, 2024-09-12 → 2026-09-11, the exact 2-year cap. Daily verified **wrong**:
`range=max&interval=1d` returns monthly/quarterly bars (INCIDENTS.md), fixed by switching to
epoch bounds. Yahoo then rate-limited the egress IP for minutes (INCIDENTS.md), so the request
rate dropped to ~2/s and a 429 now aborts the run.
**By:** Bodhi + Claude

## 2026-09-13 — Web scaffold and deployment check page
**What:** `web/` — a minimal Next.js 16 app (App Router, TypeScript, no UI library) whose only
page is a deployment check. It reads no data and is not the dashboard.
**How:** `web/app/page.tsx` renders the Vercel environment, branch and commit SHA, plus whether
`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are **set** — presence only, never
values, because `NEXT_PUBLIC_*` is compiled into the browser bundle. `force-dynamic` so an env var
added in Vercel appears on refresh rather than needing a rebuild, which is the thing being
observed. New CI job `Web build` runs `npm ci` + `next build`, which is also the type gate.
**Architecture impact:** establishes `web/` as the Vercel root directory and that the frontend is
built and type-checked in CI like everything else. No data path yet: the tables are RLS
deny-by-default with no policies, so the auth model and read policies are the next decision
before a real page can read anything.
**Verified by:** `next build` clean locally (2 routes, TypeScript pass). The deploy itself is
verified by the commit SHA on the deployed page matching the merge — recorded here once it does.
**By:** Bodhi + Claude

## 2026-09-13 — Data provider replaced: Polygon for prices, FRED for indices
**What:** Yahoo is gone. `supabase/functions/ingest/polygon.ts` serves the 36 equities and
`fred.ts` serves `^VIX`, `^VIX3M` and `^GSPC`; `yahoo.ts` is deleted. `^SOX`, `^NDX` and the
`rs_vs_sox_6m` norm are removed (decision 0019). 32 fixture tests, up from 22.
**How:** `BarProvider` gained `supports()` and `minIntervalMs`, so **routing and pacing belong to
the provider**: FRED claims `^`-prefixed symbols, Polygon claims the rest, and `syncTickers`
now refuses outright if the watchlist contains a symbol no provider serves — an index without a
source fails loudly at sync instead of leaving a column mysteriously blank. The ingest loop is
strictly sequential and waits each provider's own interval, tracked per provider so three FRED
series do not queue behind Polygon's 12.5-second gap.
**Architecture impact:** the provider seam from decision 0003 did exactly the job it was built
for — the entire data source changed and `index.ts` never learned the difference beyond routing.
Three consequences are now permanent facts of the system rather than temporary annoyances:
a backfill spans several runs (5 req/min against a wall clock), "% off all-time high" is bounded
by two years of stored history, and hourly bars are absent until session-aligned rolling lands.
All three are written where they bite rather than only here.
**Live (2026-09-13):** FRED verified working — 8,049 rows across the three index series, mean bar
gap 1.44 days, so the VIX term structure is real. Polygon verified reachable and correct, but
every equity initially failed on a float volume against a `bigint` column (INCIDENTS.md); fixed
with rounding, plus per-request timeouts and logging that the same incident showed were missing.
**Verified by:** 34 tests pass — URL construction pinned so a wrong window cannot silently
return the wrong granularity again, both DST offsets for the trading-date conversion, `"."`
observations dropped rather than zeroed, `adj_close` never filled from `close`, routing proven
exhaustive and disjoint, 429 distinguished from a rejected key. `deno check` clean. Config
validates at 36 tickers, 3 indices, 16 norms. **Not yet verified live** — no successful fetch
through either provider has happened at the time of writing.
**By:** Bodhi + Claude

## 2026-09-13 — Full daily backfill complete and independently verified
**What:** every active symbol now has daily bars — 36 equities from Polygon and 3 index series
from FRED, 25,729 rows. Plus three robustness fixes to the ingest loop and a migration closing a
publicly-callable SECURITY DEFINER function.
**How:** the backfill ran in batches against Polygon's 5 requests/minute limit. Equities carry
494 bars each (2024-09-23 → 2026-09-11) except SNDK at 390, which is correct — it only listed on
2025-02-13 after the WDC spin-off. FRED series carry ~10 years. The loop now plans before
fetching and puts symbols needing a full backfill ahead of routine top-ups, retries flaky reads
once, and keeps a failing count query to one symbol instead of the whole run.
**Architecture impact:** the data layer is done and trustworthy, which unblocks parameter views.
The `limit`/`deferred` batching is permanent while we are on the free plan, and now self-driving
rather than needing a hand-picked symbol list. Steady-state daily refresh still needs ~5 runs for
39 symbols, which is what the pg_cron schedule is for.
**Verified by:** 36/36 equities and 3/3 indices present with the latest bar; **0** impossible bars
(`high < low`, close outside its range), **0** incomplete equity rows, **0** non-positive closes
across 25,729 rows; mean bar spacing 1.46 days with a maximum of 4 (long weekends). And the real
test — all four MU golden values reproduced from Polygon data within 1.5×10⁻⁴ of figures derived
from Yahoo eight days earlier, including the Wilder RSI from a completely different recursion
start. DEFINITIONS.md §6 carries the table. Note these checks were run **by hand**; automating
them is the outstanding piece.
**By:** Bodhi + Claude

## 2026-09-13 — Daily parameter layer, and the first scripted integrity check
**What:** `daily_features`, a materialised view carrying the daily technical parameters for every
(symbol, date) we hold — Wilder RSI(14), EMA(21), SMA(50/200) with their percentage positions,
% off stored high, % above stored low, % off the 252-bar high, 20-day realised volatility, and
volume ratio — plus `scripts/verify_parameters.sql`, which checks the four MU golden values and 21
invariants and prints one row per check.
**How:** the recursive indicators are a PL/pgSQL set-returning function called once per symbol
(decision 0020); everything else is a window function with `rows` frames. Every date is computed,
not just the latest, so a backtest is a `WHERE` clause and not a second implementation
(decision 0002). Seed-decay floors are published as `rsi_daily_seed_ok` / `ema21_seed_ok` rather
than nulled, so suppression at the display layer reads a boolean instead of re-deriving a floor.
**Architecture impact:** this is the layer the grid, the digest, the rule engine and the backtester
all read, and the first three now have something to read. It also introduces a **cache that
nothing refreshes**: `refresh materialized view public.daily_features` is a hand operation until
pg_cron lands, and the verify script's freshness check exists to catch a stale one. Still missing
from the 26: everything weekly, everything cross-sectional (sector ranks, breadth), market context
(VIX band, term structure), relative strength, hourly RSI and all fundamentals.
**Verified by:** the SQL was run against a throwaway PostgreSQL 16 instance and compared column by
column with an independent Python implementation of the same definitions — **1,798 values, worst
relative error 3.9×10⁻¹⁶, zero null-placement mismatches**, including flat, monotone-up,
monotone-down, too-short and close-only (FRED-shaped) series. Cross-symbol isolation was proven by
byte-comparing one symbol's output before and after five others were added. The verify script's
own `PASS` / `FAIL` / `MISSING` paths were each exercised deliberately, which is how a `to_char`
format error that only fires on a failing check was found before it could fire on a real one.
**Not yet verified against production data** — the migration has not merged, so the five golden
checks currently report `MISSING`, which is the correct answer and not a pass.
**Update, later the same day:** merged and verified. **All 26 checks PASS** against production —
25,729 feature rows against 25,729 bars, 39 of 39 symbols, all five goldens inside tolerance
(MU RSI 60.146703 vs 60.146789; EMA(21) 943.557960 vs 943.558105; SMA(50) 938.279500 vs
938.279600; SMA(200) 606.479525 vs 606.479549; peak high 1255.00 exact). Grants confirmed from the
catalog rather than from the migration succeeding: `service_role=rDxtm` on the matview and no
PUBLIC entry on the function. Appended rather than edited into the paragraph above, because a
dated log that gets rewritten stops being evidence.
**By:** Bodhi + Claude

## 2026-09-13 — Paid data plan: 5 years of history, unlimited calls
**What:** moved to Massive (Polygon) Stocks Starter, $29/month. `FULL_DAYS` 720 → 1800,
`MIN_INTERVAL_MS` 12,500 → 200, and the per-run cap split into two defaults chosen by the cost of
the work — 45 symbols for an incremental top-up, 15 for a full backfill — plus an `offset`
parameter for walking a one-time deepening.
**How:** exactly two constants and two tests changed, which is what the old `polygon.ts` header
predicted would happen and the reason the plan's limits were named constants instead of inline
numbers. `planLimit()` moved to `provider.ts` — not `index.ts`, because that file calls
`Deno.serve` at module top level and importing it from a test starts a real listener.
**Architecture impact:** the binding constraint changes identity. It was a published rate limit; it
is now the edge function's 150-second wall clock and the payload size. Flat-file / S3 bulk access
arrives with this plan and is deliberately **unused** — the per-symbol loop is fine at 39 symbols
and becomes the wrong shape near 200. Decision 0021 has the reasoning and the rejected
alternatives.
**Note on the entries above:** earlier entries in this file describe the free tier's 5 requests per
minute and two-year window as current. They were, on the day they were written, and are left
intact — a dated log that gets rewritten stops being evidence.
**Verified by:** 36 tests pass and `deno check` is clean. The full-range URL assertion is pinned to
the literal window `/2021-10-09/2026-09-14` rather than recomputed, since a test that recalculates
the expected value cannot catch the window silently changing. The pacing test was rewritten: it
previously asserted `fred.minIntervalMs < polygon.minIntervalMs`, which held only because the free
tier was the slowest thing in the system — on Starter that ordering inverts, so each provider is
now checked against its own published limit. **Not yet verified against live data** — the
re-backfill has not run, so no symbol has more than two years of history yet, and the 200-week SMA
is still null everywhere.
**By:** Bodhi + Claude

## 2026-09-13 — The daily clock: the pipeline now runs itself
**What:** two pg_cron jobs — `swing-ingest-daily` (22:30 UTC, weekdays) and
`swing-refresh-features` (22:45 UTC, weekdays, `refresh materialized view concurrently`). With no
user-led refresh in v1, these are the entire data pipeline. Plus the 5-year re-backfill landed:
**50,402 daily bars across 39 symbols**, up from 25,729.
**How:** one fixed UTC schedule rather than DST-aware duplicates — 22:30 UTC is 18:30 ET in summer
and 17:30 ET in winter, both after the close plus the 15-minute vendor delay, which is the property
that actually matters. The refresh is a separate job so a failed ingest and a stale matview are two
visible failures rather than one silence. Decision 0022.
**Architecture impact:** the last two manual steps are gone. What replaces them is a **new class of
silent failure** — pg_net's `http_post` is fire-and-forget, so a green `cron.job_run_details` row
means "we queued a request", not "the data is good". `ingest_runs` and the freshness check are the
real signals, and this is why the grid's freshness stamp and staleness banner are requirements
rather than polish.
**Verified by:** the migration was applied against a stub `cron`/`net`/`vault` schema on a local
PostgreSQL 16 instance — it parses, registers exactly two jobs with the intended schedules, and
**re-applying it leaves two jobs, not four**. The refresh job body was extracted from the stored
command and executed for real. The stored ingest command was checked to contain a Vault lookup and
no secret value, which matters because this repo is public and `cron.job` is world-readable inside
the database. What a stub cannot prove is that pg_cron accepts these schedule strings and fires at
the right minute; **that is confirmed only by watching the first real run**.
**Re-backfill results:** all 36 equities current to 2026-09-11, 0 impossible bars, 0 non-positive
closes. 32 of 36 reach 2021-10-11 — the other four listed later (SNDK 2025-02-24, ALAB 2024-03-20,
ARM 2023-09-14, CRDO 2022-01-27). **33 of 36 now have 200+ weekly bars, up from zero**, so the
200-week SMA is unblocked. All 24 verification checks pass, including all five goldens.
**By:** Bodhi + Claude
