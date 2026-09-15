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

## 2026-09-13 — Norms in the database, and the view the dashboard will read
**What:** `norms` and `flags` tables synced from `config/norms.yml`, plus two views —
`grid_cells` (one row per symbol/date/parameter with its verdict) and `grid_status` (one row: how
current the data is and whether the page should say so).
**How:** the same shape as the watchlist sync — yml in git is the source of truth, the table is a
cache, `norms.ts` parses it. The verdict is one CASE expression over a long-format unpivot, so
adding a parameter later is one line. Decision 0023.
**Architecture impact:** this is the seam between data and dashboard. Everything the grid needs is
now one query, and the same query with a date filter answers "what did the grid look like then".
`grid_status` makes staleness a database fact rather than a frontend guess, which matters because
v1 has one run a day, no retry and no refresh button.
**Scope reality:** **4 of 16 norms** colour anything today — `rsi_daily`, `pct_off_high_stored`,
`pct_off_52w_high`, `close_vs_sma200d`. The other 12 wait on the weekly layer (3), market context
and relative strength (3), and fundamentals (5). The grid will have 11 columns of data and 4 that
are judged. That is a deliberate choice to ship a thin page and widen it.
**Verified by:** applied to a local PostgreSQL 16 fixture. Verdicts fire exactly at the norm
boundaries (min 'normal' 45.0, max 44.9 'below', min 55.5 'above' on a 45/55 band). Warm-up
behaves in three distinct states: value null before bar 15, value present but unjudged with
`suppressed_warmup` true from bar 15 to 124, and a verdict appearing at exactly bar 125 — the seed
floor. Index symbols are excluded from the grid. `grid_status` correctly reported `is_stale` true
while `last_run_ok` was also true, which is the distinction it exists to draw. 42 function tests
pass, `deno check` clean, and the real `norms.yml` parses to 16 norms and 3 flags with one-sided
bounds preserved as one-sided.
**Renamed:** `pct_off_ath` → `pct_off_high_stored` in norms.yml. Norms match parameters by name, so
the old key matched nothing and would have coloured nothing, silently.
**By:** Bodhi + Claude

## 2026-09-13 — Documentation brought level with the build; PROPOSAL v2
**What:** a docs-only pass so the written product matches the built one. `docs/PROPOSAL.md` rewritten
and versioned (v2, with a revision-history table), plus corrections in `GLOSSARY.md`,
`ONBOARDING.md` and `CLAUDE.md`.
**Why now:** PROPOSAL is the file ONBOARDING gives every new session 20 minutes to read, and it
still described four clocks, a "Refresh now" button, two RLS-enforced roles, keyless Yahoo data and
a true all-time high. None of those exist. The contradictions were being found one at a time by
whoever tripped over them, which is the expensive way.
**What changed in the docs, not the code:** one clock rather than four; no user-led refresh and no
login, with the staleness stamp and banner named as the compensating control rather than as polish;
Polygon and FRED in the stack table with the reason the previous vendor was abandoned; five years of
history and what that means for the extremes columns; norms compared in the database; hourly bars
built from minute aggregates rather than fetched, and why clock-hour bars are a different thing;
`rs_vs_sox` and `pct_off_ath` recorded as gone and renamed. Open decisions rewritten — the ticker
ceiling turns out to be a legibility question rather than a capacity one, and three genuinely new
ones are listed (sector ETFs versus indices, whether NYMO can be had honestly, which columns want
intraday).
**Architecture impact:** none. This is the paper trail catching up, which decision 0024 makes an
explicit practice — PROPOSAL is versioned, not frozen.
**Verified by:** every removed concept was grepped out of the docs tree rather than assumed gone —
"Refresh now", "four clocks", owner/viewer roles — and the two survivors in `GLOSSARY.md` were the
only real hits, both now corrected rather than deleted. ONBOARDING gained two comprehension
questions covering exactly the assumptions a reader of v1 would otherwise import.
**By:** Bodhi + Claude

## 2026-09-13 — The dashboard exists
**What:** `web/app/page.tsx` is now the grid — 36 names banded by theme, ten parameters each, with
a verdict on the four that have a norm. Plus a freshness line that is always rendered and a
staleness banner that cannot be dismissed. The old deployment check moved to `/status`.
**How:** a server component reading `grid_status`, `tickers`, `grid_cells` and `norms` through
PostgREST with the service_role key, cached 15 minutes, pivoted to a row per ticker in the page.
The long-format view means adding a parameter later is one line in `COLUMNS` and one in the view.
Decision 0025.
**Design:** severity is a left stripe plus a weight change as well as a colour, so it survives
greyscale and colourblindness. The semantic colours are **blue for below a norm and ochre for
above** — deliberately not red and green, because below means possibly cheap and above means
possibly stretched, and this tool has no view on which is good. Unjudged values render grey: "we
have no opinion" must not look like "inside the norm". A `*` marks a value inside its warm-up
window — shown, never judged.
**Architecture impact:** the read path exists end to end for the first time. RLS stays
deny-by-default with **no read policy at all**, because nothing but the server reads the database.
**Verified by:** `next build` with **no environment variables at all**, the way CI runs it — passes,
and prerenders a page that names the missing variables rather than crashing. Rebuilt against an
unreachable host: renders `grid_status: could not reach example.invalid (fetch failed)` instead of
a 500. And the one that matters most — built with a **sentinel value** in
`SUPABASE_SERVICE_ROLE_KEY` and grepped the client bundle and every served HTML file for it:
**zero occurrences**. Next inlines `NEXT_PUBLIC_*` into the browser at build time, this repo is
public, and a leaked service_role key is irreversible, so that check is run rather than reasoned
about.
**Not yet verified:** the page has never rendered real data. The sandbox has no network route to
`*.supabase.co`, so the happy path is confirmed only by the first deploy with the env vars set.
**By:** Bodhi + Claude

## 2026-09-13 — Freshness that will not cry wolf
**What:** `grid_status` rewritten so staleness measures the pipeline — hours since the daily ingest
last completed successfully — instead of the gap to the newest bar. The dashboard banner and the
header stat follow. `stale_days_price` in `config/norms.yml` becomes
`pipeline_stale_after_hours: 30`.
**Why:** the first version would have fired the banner on the first market holiday. Friday's bar, a
closed Monday, Tuesday's check reads four days against a three-day threshold, and the page tells ten
people that healthy data is broken. Decision 0026.
**Architecture impact:** none structurally, but it changes what the page is asserting. It no longer
claims to know the market calendar; it claims to know whether its own pipeline ran. That is a
smaller claim and a true one, and it is the claim the email digest will need too — which is why it
was fixed before the digest rather than after.
**Verified by:** seven scenarios exercised against a local PostgreSQL 16 fixture, each inserting a
different run history and reading the verdict. Ordinary weekday, Sunday, and **Monday holiday with
a healthy cron** all read fresh. Failed cron, a week of silence, and never-succeeded-at-all all read
stale. The subtle one: a config-only sync one hour ago does **not** mask a price pipeline that last
succeeded 40 hours back — it still reads stale, because only runs that actually fetched bars count
as evidence. `next build` with no environment still passes.
**Also caught:** `create or replace view` cannot rename a column, so the migration drops and
recreates. Worth knowing because the error is clear but only appears at apply time — and because a
test script of mine printed "OK" after the failed step, which is exactly the kind of false green
this project keeps finding.
**By:** Bodhi + Claude

## 2026-09-13 — The email digest, built but not yet sending
**What:** a `digest` edge function plus two views. `digest_changes` reports cells whose norm verdict
changed since that symbol's previous stored date; `digest_standing` reports everything currently
outside a norm, so a long-standing condition does not vanish after the day it began. `auth.ts`
moved to `supabase/functions/_shared/` and is now shared by both functions.
**How:** decision 0027. The email is plain text, names parameters the way the dashboard does, counts
crossings and recoveries separately, and always states the close date in the subject.
**Deliberately NOT scheduled.** Sending is irreversible and a hard stop, so the function ships with
`?send=0` - which renders the email and returns it without sending - and the cron entry is a
separate change made only after a dry run has been read. Nothing about merging this PR sends mail.
**Architecture impact:** the phone surface from PROPOSAL §4 now has an implementation path. It also
introduces the first thing in this system that reaches outside on a schedule and cannot be undone,
which is why the stale-suppression rule is a tested behaviour rather than a convention.
**Verified by:** 8 new tests on the pure renderer, 50 across both functions, `deno check` clean on
all three directories. The tests cover the failure modes that are invisible until after delivery:
a stale pipeline must carry **no** market content (asserted by absence, not just by the banner
being present), a quiet day must say so explicitly rather than arrive looking truncated, the count
in a section heading must match the number of lines beneath it, a null renders as a dash rather
than NaN, and an unmapped parameter falls back to its raw name rather than leaving a gap.
**Dry-run against production data, read-only:** the change query would have reported 6 crossings on
2026-09-11 - SNDK and STX moving outside, CAT, MRVL, QCOM and STX coming back in. A plausible daily
volume, and a mix that shows the bidirectional design working rather than only flagging weakness.
**By:** Bodhi + Claude

## 2026-09-13 — The digest is scheduled; the system now sends mail
**What:** `swing-digest` at 23:00 UTC on weekdays, after the 22:30 ingest and the 22:45 rebuild.
Plus a precision fix: the digest now reports two decimals.
**Why the precision fix:** the dry run produced two lines that contradicted themselves. QCOM at
**-29.99** against a -30 norm rendered as "-30.00 → back inside"; CAT leaving a -25 norm from
**-25.0088** rendered as "-25.0 → was outside". Both verdicts were right and both lines read as
wrong, which is worse than being wrong - it teaches the reader to distrust the email. Decision 0028.
**Architecture impact:** this is the first thing in the system that reaches real people on a timer
and cannot be recalled. The kill switch is one `cron.unschedule` and is written into the migration
header where someone looking for it in a hurry will find it.
**Verified by:** the dry run was read end to end against live data before this was written, and it
matched what the views predicted exactly - 2 out, 4 back in, 36 values across 22 names still
outside, for the close of 2026-09-11. 8 digest tests still pass with the new precision. The
schedule itself cannot be verified before it fires; **the first real send is Monday 2026-09-14 at
23:00 UTC**, and the thing to check afterwards is `ingest_runs` where scope = 'digest', which
carries Resend's message id on success and the error text on failure - not the cron log, which
reports success as soon as the request is queued.
**By:** Bodhi + Claude

## 2026-09-13 — Formula regressions now fail the build
**What:** a `parameters` CI job. PostgreSQL 16 service container, every migration applied in order
to an empty database, a synthetic fixture loaded, and `daily_features` compared against values an
independent implementation computed from the same series. Plus `scripts/ci/` as a set of files
anyone can run by hand against any empty database — `scripts/ci/run.sh` is the whole gate.
**How:** decision 0029. The fixture is shaped to hit edges rather than to look realistic: a steady
trend, a drawdown that drives RSI low, a dead-flat stretch, and a gap up. Three degenerate
companions cover a flat series (RSI undefined, not 50), a 10-bar series below every window, and a
close-only series shaped like a FRED index.
**Architecture impact:** this closes the integrity gap that has been the top outstanding item since
the parameter layer landed. It also makes the practice repeatable rather than remembered — every
migration in this project has been verified against a throwaway PostgreSQL before its PR, and that
is now a committed script rather than a habit.
**What it does NOT gate, stated plainly:** the MU golden values. Reproducing them needs a real price
series, and the data plan is licensed for individual use, so committing one to a public repo is
redistribution. They stay a manual check against production. CI gates the formulas; the goldens
gate the data and the basis.
**Verified by:** the gate ran green end to end locally — 24 formula assertions across four dates,
four degenerate checks, two scheduling checks, and all 26 invariant checks from
`verify_parameters.sql`. RSI, EMA and SMA agree with the independent reference at **exactly
0.000e+00** relative difference; realised volatility at 1.6e-16. The five golden checks report
MISSING, which the runner treats as expected rather than as failure, and says so.
**Two bugs the exercise found in itself:** an idempotency loop asserting that every migration could
be re-applied — false, and correctly failing, since migrations here are forward-only; and a counter
treating the SUMMARY row as a check, which reported a clean run as failing.
**By:** Bodhi + Claude

## 2026-09-13 — The weekly layer, and Wilder's recursion stops existing twice
**What:** weekly parameters. `public.weekly_bars` rolls daily bars into ISO (Monday) weeks;
`public.weekly_features` publishes `rsi_weekly`, `ema21_weekly`, `sma30w`, `sma200w`, the three
`close_vs_*` distances, `weeks_available`, and the two seed flags. Hard constraint 5 — weekly reads
the last completed week — is now a column (`is_complete`) rather than a rule someone has to
remember.
**How:** migration `20260914010000_weekly_features.sql`, decision 0030. Wilder's smoothing and the
EMA seeding moved into `public.recursive_indicators(date[], double precision[])`, which knows
nothing about tables or timeframes; `daily_recursive` became a thin wrapper over it and the weekly
matview calls the same function. Arrays rather than a table name, so it cannot re-couple to one
timeframe. `close` is the **last** daily close of the week, not Friday's, so a holiday-shortened week
is a normal week with fewer bars.
**Architecture impact:** the formula exists once, which is the point — two copies is how a project
ends up shipping a daily RSI and a weekly RSI that disagree about what RSI means, and hard constraint
7 puts that gap at 9.4 points. Also, `swing-refresh-features` now refreshes **both** matviews; it
named only `daily_features` before.
**What made a risky refactor safe:** rewriting a function the daily layer already depends on would
normally be reckless. The CI formula gate from decision 0029 compares `daily_features` against an
independent implementation at 1e-9, so it reported *every daily formula value unchanged by the
refactor*. First time a gate built for one purpose has paid for itself on a different one.
**Verified by:** `scripts/ci/run.sh` green end to end — 9 weekly formula assertions against
independently computed expectations (worst relative difference **3.8e-16**, and a null expectation
matched by a null), 3 weekly structural checks, every daily assertion unmoved, and all invariants
passing. Production goldens: MU's week of 2026-08-31 at `rsi_weekly` 63.562709 and `ema21_weekly`
839.355683, now scripted in `verify_parameters.sql` at the **same 1e-3 as the daily goldens** —
re-measured residual seed weight is 1.75e-08 and 1.87e-10, five orders of margin, which overturned
the recorded plan for this task.
**The sixth "operation that succeeds and changes nothing", caught by CI rather than by production:**
a matview is populated once, at creation. Without amending the refresh job, `weekly_features` would
have been correct on day one and a day staler every day after, silently. The weekly assertions came
back MISSING — in CI the migration runs before the fixture loads — and the fix there is the same fix
as the one production needed.
**A check that was wrong in a way worth recording:** the short-week assertion was first written
against a *global* newest week and failed on the fixture's deliberately-short `SHORT` series, whose
own newest week is older than another symbol's — correctly incomplete, wrongly flagged. A short
history and a short week are different things. Now per-symbol.
**By:** Bodhi + Claude

## 2026-09-15 — The digest survives a bad read, and the dashboard stops guessing
**What:** the weekday digest no longer goes silent when one of its reads fails, and the dashboard no
longer reports a missing field as a healthy pipeline. Both are the same bug in two places, found a
day apart.
**How:** decision 0031. New `supabase/functions/digest/retry.ts` — `readWithRetry`, three attempts at
200 ms and 600 ms, injectable `sleep` so it is testable without waiting. `index.ts` runs its three
reads through it, still in parallel, and collects the failures into `unavailable` instead of throwing.
`render.ts` now takes `Status | null`, `Change[] | null`, `Standing[] | null` and an `unavailable`
list: **null means unknown, empty means nothing happened**, and the two must never render alike. On
the web side, every field of `Status` became optional, which forced `page.tsx` to separate `undefined`
from `null` — a new "Freshness could not be read" banner, checked *before* the stale banner because
"no verdict is available" outranks a verdict.
**Architecture impact:** the digest's `ok` in `ingest_runs` keeps a single meaning — did mail go out —
with `unavailable` and `read_attempts` recorded beside it. `read_attempts` is logged even on a clean
run, so a replica starting to misbehave shows up as twos before it costs an email.
**Verified by:** 21 tests, `deno check` clean. Seven cover the retry loop, including the 2026-09-14
failure reproduced exactly (one failure then success), a ceiling on attempts, a thrown error being
retried rather than escaping, and `null` rather than `[]` on give-up. Six cover degraded rendering,
the load-bearing one being *an unread change list NEVER renders as a quiet day*. **All six new render
tests were run against the previous `render.ts` and all six failed**, while the eight pre-existing
tests and a new "a healthy run is completely unchanged" test passed — so they encode the new intent
rather than merely agreeing with the new code.
**A real bug the type checker caught:** `readWithRetry` first typed its callback as returning
`Promise`. A PostgREST builder is a *thenable* — it has `.then` but not `.catch`, so it does not
satisfy `Promise`. It ran correctly under `deno test` and failed `deno check`, which is the CI step
that would have blocked the merge. Now `PromiseLike`.
**By:** Bodhi + Claude

## 2026-09-15 — The weekly columns reach the grid
**What:** the dashboard shows RSI 14, vs 21 EMA, vs 30W SMA and vs 200W SMA on weekly bars, in their
own labelled block beside the daily ones. `grid_cells` carries both timeframes; the digest does not.
**How:** decision 0032, migration `20260915060000`. New `weekly_asof` view puts each week's successor
alongside it so a daily row can range-join to the newest week that started before its own week —
`week_start < date_trunc('week', d)`, which needs no market calendar and no `is_complete` flag, and
therefore gives the same answer in a backtest as it does today. `grid_cells` is replaced in place
with a trailing `timeframe` column, so every dependent keeps working. `config/norms.yml` loses the
`close_vs_sma200w` entry; the sync deletes the row, which is what that file being the source of truth
means.
**Architecture impact:** weekly columns are constant Monday to Friday and step on the week boundary.
That is correct — a weekly bar has one value — and it is why a weekly cell changing colour mid-week
would be a bug rather than a move. The grid header is now two rows, because "vs 21 EMA" means a
different number on each side of the divider.
**Verified by:** `scripts/ci/run.sh` green, 80 checks. Seven are new: the as-of join re-derived a
different way (correlated `max()` against the view's `lead()` range join), the source week having
ended before the day it is shown, a weekly value being constant within its week, no weekly cells
before a symbol's first completed week, `timeframe` taking only two values, all ten daily params
surviving the in-place view replacement, and no weekly param reaching the digest.
**The negative test, which is the one that counts:** the view's `<` was changed to `<=` so a day
could see its own week. The value-comparison check failed with **230 mismatches** — and every other
as-of check still passed. That is written into `check_formulas.sql`, because a reader needs to know
which of those seven is load-bearing and which are shape checks.
**A check that was wrong before the code was:** the look-ahead assertion first joined
`grid_cells` to `weekly_features` on value equality with `is not distinct from`, which matches every
null to every null and reported 3,347 phantom violations. A check must identify the row it is
judging, not infer it from a value.
**By:** Bodhi + Claude

