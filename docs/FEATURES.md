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

## 2026-09-15 — The index series stop running a day behind
**What:** an `indices` scope on the ingest, a fourth cron job that uses it at 11:00 UTC daily, and
`public.index_status` — how far each FRED series lags the equities, counted in trading days so a
weekend reads as zero. Groundwork for market context.
**How:** decision 0033, migration `20260915120000`. `provider.ts` gains `Scope`, `SCOPES`,
`isScope()` and `universeFor()`, so "which symbols does this run touch" is one exhaustive switch
rather than a boolean at two call sites; `activeSymbols` takes `"all" | "equities" | "indices"`
instead of an include-indices flag, which could not express the one case the morning run needs.
**Architecture impact:** an index run writes `detail.indices`, never `detail.daily`, so it cannot
reset the grid's staleness clock. Anything reading the index series — market context first — takes
its as-of date from `index_status` rather than from the grid's date, because the two can legitimately
differ by a day.
**Verified by:** 47 ingest tests (5 new, covering exhaustive scope→universe routing, `indices` not
being reachable through `all`, hourly excluding indices, and the validator rejecting near-misses like
`"index"` and `"Daily"`), `deno check` clean, and the CI gate green at 83 checks — including three
new scheduling assertions that four jobs are registered exactly once, that the new one asks for
`scope=indices` rather than `all`, and that it runs every day rather than weekdays.
**Measured, and honestly bounded:** at the 22:30 run on 2026-09-14 all 36 equities returned Monday's
bar and all three index series stopped at Friday. That is the whole of the clean evidence — every
other index row came from one backfill — so **FRED's publication hour is not known**, 11:00 UTC is
chosen to be comfortably late rather than tight, and `index_status` is what will let us tighten it.
**By:** Bodhi + Claude

## 2026-09-15 — The market block
**What:** `public.market_context` — one row per tracked date carrying VIX level and fixed regime
band, VIX term structure, S&P 500 close, and watchlist breadth, with the as-of date of every borrowed
index value published beside it.
**How:** decision 0034, migration `20260915130000`. A plain view, not a matview, because its inputs
refresh on two clocks (22:30 equities, 11:00 indices) and a matview would be right only between them.
Each FRED series is joined as-of — newest bar on or before the date — via `left join lateral`, so a
date with no index history still yields a row of nulls rather than disappearing from the series.
**Architecture impact:** first surface to read `index_status`'s premise rather than the grid's date.
Anything built on the market block takes its currency from `vix_as_of`, not from `d`.
**Verified by:** the CI gate at 30+ checks including nine new ones — every band matching its own
value, all five bands actually occurring, term structure never computed across two dates, a VIX day
with no VIX3M reporting null rather than a number, no index value dated after its row, the as-of VIX
re-derived with `max()` against the view's `limit 1`, breadth null exactly when nobody is eligible,
breadth inside 0..100, and eligible never exceeding tracked. Production spot-check: Monday
2026-09-14 correctly shows VIX 15.84 **as of 2026-09-11**, band `<16`, term +17.42%, breadth 77.8% of
36 eligible.
**The fixture earned its keep.** `scripts/ci/fixture.sql` gained hand-written `^VIX`, `^VIX3M` and
`^GSPC` series shaped to cross every band boundary (including `>80`, which production has seen once
in eleven years), to leave gaps that force the as-of fallback, to put VIX3M below VIX so
backwardation is covered, and to drop VIX3M entirely on a cycle. That last one **caught a real
defect**: the first version of the view happily divided today's VIX by an older VIX3M and reported a
clean percentage.
**By:** Bodhi + Claude

## 2026-09-15 — The gate can no longer pass by not running
**What:** `scripts/ci/run.sh` fails the build when a check file errors, or when it runs but produces
implausibly few rows.
**How:** a doubled quote made `check_formulas.sql` unparseable; the gate printed the error, counted
zero failures, and exited 0 with `all green`. It counted rows whose status read FAIL, and a file that
does not parse emits no rows. `status_count` also ran without `ON_ERROR_STOP` and sent stderr to
`/dev/null`, discarding the evidence. `run_checks` now uses `ON_ERROR_STOP=1`, fails with a named
message, and enforces a row floor deliberately set far below the real count so adding checks never
breaks the build.
**Architecture impact:** the detector is now checked the way the components are. Seventh instance of
"a successful operation that changed nothing", and the first where the operation was the check.
**Verified by:** breaking it deliberately, twice — a syntax error and a file that parses but selects
nothing — and asserting on the **specific message** each guard prints rather than on the exit code.
That distinction mattered: the first attempt at this test had both variants dying in `bootstrap.sql`
on a leftover role and never reaching the check file, so the non-zero exits proved nothing.
**By:** Bodhi + Claude

## 2026-09-15 — Relative strength vs the S&P 500
**What:** `public.relative_strength` — out/under-performance against SPX at 63, 126 and 252 trading
bars, in percentage points, per (symbol, date).
**How:** decision 0035, migration `20260915140000`. `lag(close, n)` over each series' own partition,
joined to SPX on an exact date so both windows end on the same session. A view, not a matview: 441 ms
for the whole 42,353-row history, and a matview would need refreshing on both the 22:45 and 11:00
clocks.
**Architecture impact:** rows exist only on dates where both legs have a bar, so the newest trading
day is absent until FRED publishes — a blank is the correct rendering of "not computable yet", and
`index_status` explains it. Deliberately no as-of layer; the measurement behind that is in 0035.
**Verified by:** the CI gate green, with four new `rs` checks — a row existing only where both legs
have a bar, RS null until the symbol has n bars of its own, **the whole calculation re-derived from
raw bars** with `offset n` instead of `lag(n)` and compared at 1e-9, and no index scoring against
itself. Production spot-check on 2026-09-11: the 252-bar ranking is led by SNDK, MU, WDC, DELL and
STX — the memory and storage names — with META, SMCI and COST at the bottom.
**The fixture was extended from 200 bars to 300, and that mattered.** At 200, `rs_252b` was null on
every single row: the column was present, parsed, and never once computed. **A column that is always
null passes every check anyone writes about it.** At 300 bars the 252-bar lookback is reachable and
18 rows exercise it.
**By:** Bodhi + Claude

## 2026-09-16 — The grid answers in milliseconds again
**What:** no visible change. The dashboard banner and the nightly digest stop timing out; every
number, column and colour is identical.
**How:** decision 0036, migration `20260916060000`. The weekly as-of lookup becomes an equality —
`weekly_in_force` resolves each week's source week once, so a daily row joins on its own week instead
of searching a range. `grid_status` and `digest_standing` read `daily_features` for the newest date
and the symbol count rather than aggregating every cell to find them. `weekly_asof` is dropped.
**Architecture impact:** the project now has a class of defect it tests for by **plan shape** rather
than by value. `check_formulas.sql` gains a `shape` section: an unfiltered read of `grid_cells` must
contain no `Join Filter`, `grid_status` must not touch the weekly layer, and every week with a daily
bar must have a weekly row. Structural assertions hold at fixture size, where a timing assertion
would prove nothing and flake.

| | before | after |
|---|---|---|
| `select max(d), count(distinct symbol) from grid_cells` | 3,141 ms | 528 ms |
| `select * from grid_status` | 3,192 ms | **23 ms** |
| `select count(*) from digest_standing` | 3,124 ms | **9 ms** |
| `select count(*) from grid_cells` | 3,124 ms | 240 ms |

**Verified by:** `scripts/ci/run.sh` green — 67 formula checks, all passing, three of them new — and
old vs new `grid_cells` identical row for row on the fixture (8,744 each, `except all` empty both
ways).
**The negative test, which is the one that counts:** with the 2026-09-15 band join and the old
`grid_status` pasted back, the two new plan checks fail with `Join Filter present` and `weekly layer
scanned` — the specific messages, not merely a non-zero exit — while all 65 other checks pass and the
gate's counter reports 2. A daily bar inserted into a week with no weekly row makes the third fail
with `1`.
**By:** Bodhi + Claude

## 2026-09-16 — A transient vendor error costs a pause, not the night's bar
**What:** the ingest now retries the vendor, not only Supabase. A 502 or a dropped connection from
Polygon or FRED is asked again instead of losing that symbol until the next scheduled run. Two norms
change with it: `rsi_weekly` widens to 40/70 and the RS norm is renamed `rs_vs_spx_126b`.
**How:** decisions 0037 and 0038. New `supabase/functions/ingest/http.ts` holds one policy for both
providers — retry transport faults and 5xx, **never any 4xx**, under a 45 s per-symbol wall clock so
one sick symbol cannot eat the function's 150 s budget. The per-attempt timeout moved there from the
two providers; their status handling is untouched.
**Architecture impact:** 429 stays un-retried and still aborts the run. That is not an oversight to
tidy up later — retrying a rate limit is what got our egress IP blocked by Yahoo and cost us a whole
provider (decision 0019). Anyone tempted to "just retry everything" should read 0037 first. Norms
reach the grid through the 22:30 ingest, not through the merge, so the two norm changes land that
evening.
**Verified by:** `deno test --allow-env` — **55 tests, all passing**, 8 of them new — and
`deno check` clean on every file.
**The negative test, which is the one that counts, done twice.** With `DEFAULT_ATTEMPTS = 1` the five
new-behaviour tests fail (a 502 then a 200, a transport fault then a 200, the give-up count, the pause
schedule, the deadline) and the three guards pass. With the policy changed to the tempting wrong one
— retry 4xx too — the guards fail, **including the 429 test that predates this work**. Each set is
blind to the other's failure mode, which is why both were run.
**By:** Bodhi + Claude

## 2026-09-16 — The market block and relative strength reach the page
**What:** a four-tile strip above the grid — VIX, VIX term structure, S&P 500, breadth — and a
sixteenth column, **vs SPX 126b**. Both were computed and verified in the database and shown nowhere.
Each market tile carries its own as-of date when that date is not the grid's; the RS column group
carries one under its heading for the same reason.
**How:** decision 0039, migration `20260916140000`. Two new views, `rs_cells` and `market_cells`,
publish the cell shape `grid_cells` already publishes, **verdict included** — the page renders colour
and never decides it. `config/norms.yml` renames `vix_term_struct` to `term_structure`, the third
norm this week that was named for an idea rather than for the parameter it judges and therefore
coloured nothing.
**Architecture impact:** three views now spell out the same below/normal/above CASE. That is
deliberate — a scalar function would be a per-row call the planner cannot see through, days after a
planner problem took the site down — and all three are asserted against a single reference expression
in CI, so a copy cannot drift alone.

The page also learned to fail in parts. A failed `market_cells` or `rs_cells` read now costs its own
block and a line saying so; only the three reads the grid cannot render without can fail the page.
**An unread block says it is unread — it never renders as an absence of data.**

**Verified by:** `scripts/ci/run.sh` green — **74 formula checks, 7 new** — `next build` clean
including its TypeScript pass, and the page rendered from a fixture of real 2026-09-15 production
rows and read at 1280 / 1440 / 1680 / 1920 in both light and dark.

**Three things that only showed up once it was on screen, all of them measured rather than guessed:**

- The RS column was **off the right edge at every width**: the table needed 1726px inside a 1500px
  frame. The frame is now 1800px and the group label short, which brings the table to 1534px — it
  fits whole from 1680 up.
- The RS group label was `white-space: nowrap` over a group of ONE column, so the label was setting
  the column's width: "Relative strength — vs S&P 500, as of 2026-09-14" made it 350px with the
  number marooned at the far right. The date moved to the column's own sub-line, where the norm
  already sits.
- The divider between column groups was found with a `find`, which returns the FIRST one. With a
  third group it drew the daily/weekly rule and silently skipped weekly/RS — a defect that looks
  like a style choice. Now a Set.

**A blind spot this PR found in the existing gate, which is the part worth keeping.** DEFINITIONS
says a value equal to a norm bound is INSIDE the band. Changing `<` to `<=` in a verdict passed every
check in the suite. The reason, measured: **zero cells in any view sat exactly on a norm boundary** —
so `<` and `<=` had always been indistinguishable to CI. A fixture norm now lands exactly on a real
value, and the mutation fails two checks. That hole was older than this work.
**By:** Bodhi + Claude

## 2026-09-16 — The seven fundamental definitions are settled (docs only)
**What:** no code. `docs/DEFINITIONS.md` §7 goes from "still open — each needs a decision before
launch" to seven settled definitions with the formula, the tags and the null rule for each. Analyst
target gap leaves the table: it is not in SEC XBRL and is a searched column, not a fundamental.
**How:** decision 0040. Four calls were genuinely open — diluted EPS with a null on negative TTM
earnings, operating leases counted as debt in **both** the leverage ratio and EV, capex including
capitalised software, and quarterly YoY revenue growth rather than TTM. Two were not real forks and
took the recognisable construction with the definition stated on the column.
**Architecture impact:** the contract is written before the code, so the implementation cannot quietly
decide a formula by whatever it happens to do. It also unblocks **step 8** — sector-relative ranks are
percentiles of FCF yield and gross margin within a theme, and could not be defined while FCF yield
was not.
**Two things deliberately left open, in writing:** tag availability across the 36 filers, and the
effective-tax-rate clamp band in ROIC. **No band is written into §7** — a number invented at a desk
would be obeyed forever, so §7 says ROIC is not implementable until the band comes from real filings.
Saying "we do not know this yet" in the spec is the point of the spec.
**Verified by:** nothing executable — this PR changes no code. `scripts/ci/run.sh` still green
(74 formula checks), unchanged from the previous merge, which is the honest claim: this is a
docs-only change and CI can only confirm it broke nothing.
**By:** Bodhi + Claude

## 2026-09-17 — The universe becomes 43 companies and 10 ETFs
**What:** 36 tickers → 53. A new **SaaS** theme (CRM, NOW, ADBE, INTU, SHOP, DDOG, SNOW) and ten
**ETFs** (SPY, QQQ, DIA, IWM, SMH, XLK, XLF, XLE, XLV, XLY), plus two theme moves from the UI
spec: INTC → AI silicon, CRDO → Foundry/analog/IP.
**How:** decision 0041, migration `20260917060000`. New `tickers.is_fund`, set per entry in
`config/watchlist.yml` with `fund: true`. Funds leave watchlist breadth; nothing else changes.
**Architecture impact:** the project now distinguishes **two kinds of exclusion**. An index is
context and is never a row; a fund is a row whose fundamentals are not-applicable rather than
missing. Reusing `is_index` for both would have deleted ten rows from the grid without a word.
`breadth_tracked` now reads **43**, not 53 — read it as the answer to "does breadth cover what I
think it covers".

**Expect `tickers_without_features` to FAIL against production for about two nights.** Seventeen
new symbols have no bars, and the automatic full catch-up is capped at 15 symbols per run
(`DEFAULT_LIMIT_FULL` in `provider.ts`), so it takes two nightly runs to backfill them. That check
is a real invariant and it will be correctly unhappy until then. It is not a CI failure — CI runs
against the fixture — and it self-heals; if it is still failing on the third morning, something
else is wrong.

**Verified by:** `scripts/ci/run.sh` green at **78 formula checks, 4 new**, plus `deno test`
57 passing and `deno check` clean.
**The negative tests, both of them the design rather than the code.** Put funds back into breadth:
the all-dates check fails with `320 disagree`. Set the fixture fund's `is_index = true` — the
tempting overload this decision exists to refuse: the grid-row check fails with `0 fund cells`.
**And two of my own checks were wrong before they were right**, which is the part worth recording:
the fund's bars were copied beside the ticker insert, before the source symbol had any, so it had no
history and left breadth for being *ineligible* rather than for being a fund; and the first breadth
assertion compared a **per-date** `breadth_tracked` against a **universe-wide** ticker count, which
failed correctly on the fixture. The check now compares the whole series against itself and needs no
date picked at all.
**By:** Bodhi + Claude

## 2026-09-17 — The moving averages start saying what they mean
**What:** five Technicals columns, derived from data the database has held since day three — MA
stack (Full bull / Full bear / Mixed), the SMA50×SMA200 and EMA21×SMA50 crosses each with **trading
bars** since, and both MA slopes as percent per week.
**How:** decision 0042, migration `20260917120000`. New matview `daily_signals` and view
`signal_cells`. No ingest change, no vendor, no new data — `close`, `ema21_daily`, `sma50` and
`sma200` were already there; what the spec wanted was what they say about each other.
**Architecture impact:** a **matview, not a view**, because a filter cannot pass through a window
function — `where d = today` on a view would recompute every symbol's whole history per page load.
And a new kind of cell: `signal_cells` publishes a categorical **label** plus an optional number and
a **tone**, where every other cell view publishes a number and a norm verdict. A tone comes from the
label, not from `config/norms.yml`, and CI asserts no norm key can ever reach a signal param —
otherwise editing a threshold could silently restyle a chip.
**Verified by:** `scripts/ci/run.sh` green at **91 checks, 13 new**; `deno test` 57 passing.
**Mutation-tested four ways, all four caught by the right check:** off-by-one on bars-since for each
cross, slope lookback of 4 bars instead of 5, and the stack loosened from `>` to `>=`.

**Two things went wrong first, and both are the point of the entry.**

**The gate went green with the new matview entirely empty.** A matview is populated once at create
time — in CI, before the fixture loads — and `run.sh` did not refresh it. This is the
`weekly_features` failure of 20260914010000 repeating, an hour after the warning about it was
written into this migration's own header. The fix is not the missing refresh line: two **generic**
checks now ask `pg_matviews` what exists rather than naming anything, so the next matview added
without a refresh fails the build by name. Verified against a throwaway empty matview.

**And the bars-since check was blind to the bug it existed to catch.** It guarded on `prev_bars is
not null`, which excluded exactly the rows that mattered — the fixture has one 50×200 crossing per
symbol, so on that bar there is no previous value and the row was skipped. An off-by-one passed the
whole gate. The non-vacuity guard did not help either: it asked whether *either* cross had events,
and 21×50 had six per symbol, so it vouched for coverage that did not exist. Both rewritten — the
reset rule is asserted directly with no guard, both crosses are checked, and non-vacuity is per
cross type.
**By:** Bodhi + Claude

## 2026-09-18 — The grid becomes a dashboard
**What:** two tabs, four presets over a 51-column catalogue, eight cell states, a pinned symbol
column, collapsible theme bands, per-column sort within themes, a symbol-or-company filter, and a
cell detail sheet. `/deep-dive` is an honest placeholder that lists its seven sections and says
which are blocked on data and which on a charting layer.
**How:** decisions 0043 and 0044. No migration, no ingest change, no new data — every number comes
from `grid_cells`, `rs_cells`, `market_cells` and `signal_cells` exactly as they already publish it.
`web/lib/columns.ts` is new and holds the catalogue, the presets and the state model; `web/lib/
market.ts` holds the four tiles; `web/components/ParameterGrid.tsx` is the table.
**Architecture impact:** the first client component in this app, and therefore the first time the
service_role key could reach a browser bundle. `lib/grid.ts` is now only what needs that key;
`lib/columns.ts` and `lib/market.ts` are pure and are what the browser imports. Two new gates:
`scripts/ci/check_web_boundary.sh` (four rules) and `scripts/ci/check_cell_states.sh` (every
declared state reachable and styled). A planned column is shown with its label, its group and
`planned` under the heading — never hidden and never silently blank — so the Value block reads as
27 parameters designed and not built rather than as 27 columns of missing data.
**Also:** one-sided norms now read `≥ -25` / `≤ 4` rather than a bare `-25`, which did not say which
side of the number the band was on. Two of the fifteen norms in `config/norms.yml` are floors and
one is a ceiling, so that is the common case. And `app/icon.svg`, because `/favicon.ico` answered
404 on every page load and put an error in the console of a page whose premise is that nothing on it
is unexplained.
**Verified by:** `npx tsc --noEmit` clean; `npm run build` green at 5 routes; both new checks pass
and both were negative-tested — the boundary check's backtick rule once, the state check four ways
(old ordering, an unreachable state added to the union, a renamed selector, a deleted rule). Then
the page built against a fixture of **real production rows** for `d = 2026-09-16` and read at
1280 / 1440 / 1680 / 1920 in both themes, in all four presets, with the cell sheet open and the
table scrolled to both ends. No JS errors, no body-level horizontal scroll, scrim correct at every
position, all eight states rendering in the All preset.

**Three defects appeared only on screen, and that is the point of reading it rather than measuring
it.** A cell state that could not render, every judged cell silently losing its colour, and the
backtick build break for the third time — all three in `docs/INCIDENTS.md`, all three past a clean
type check and a green build. The 2026-09-16 market block had three of these too. A dense table is
a thing you have to look at.

**Not in this phase:** market-history charts, `grid_cell_history` for the cell sheet's five-year
series, and the Deep Dive stock strip. All three need a charting layer, which nothing in
`web/package.json` provides today; the market charts come first because they serve every name at
once rather than one at a time.

## 2026-09-18 — The page can tell "tracked" from "priced today"
**What:** `grid_status` publishes `symbols_priced` (how many tracked symbols have a bar on
`data_through`) and `symbols_behind` (how many do not). The dashboard shows a `Priced today` stat
when the two differ, and a banner naming the count and saying why those rows are blank. Previously
the header could only say "53 names", which on 2026-09-18 was true while eleven of them were a day
behind.
**How:** migration `20260918060000`, regenerated by substitution from the `20260916060000` view body
rather than retyped. Two columns **appended**, because `create or replace view` may add trailing
columns and nothing else — which also means every existing reader is untouched.
**Architecture impact:** per-symbol staleness becomes something the data layer can see. `is_stale`
still measures the PIPELINE and is deliberately unchanged: a stale pipeline and a partial day are
different failures, can be true at once, and are rendered as two banners rather than one branch of
an if/else. `Status` in `web/lib/grid.ts` keeps both fields optional for the reason every field
there is — `undefined` means the deployment predates the migration and we know nothing, which must
never render as "all present".
**Also in this change, and the reason for it:** `DEFAULT_LIMIT_INCREMENTAL` 45 → 90 (decision 0045),
plus a deno test that fails when the per-run cap drops below the watchlist, and a
`verify_parameters.sql` invariant that fails when a symbol goes from current yesterday to missing
today. See `docs/INCIDENTS.md` — the cap had been silently starving a fixed alphabetical tail every
night since the universe went to 53.
**Verified by:** `scripts/ci/run.sh` green against a local PostgreSQL with the new migration applied
— 39 checks, 0 failing, 7 goldens MISSING as expected. The new invariant was mutation-tested by
deleting one fixture symbol's newest bar, which moved it from 0 to 1 and failed the gate. `deno
test` 79 passing, and the cap guard negative-tested three ways: the old cap of 45, a watchlist grown
past 90, and `^GSPC` removed from the yml. The page was read against a fixture carrying
`symbols_priced: 19, symbols_behind: 3` at 1280 / 1440 / 1680 / 1920 in both themes, with the stat
and the banner rendering and the header strip intact.

## 2026-09-18 — The market block gets six months of history
**What:** a collapsible Market history panel between the market tiles and the grid, with four
charts over the last 126 sessions: VIX with its 20-bar average and the 16/30 norm band; a regime
strip showing which side of that band each session closed on; term structure anchored at zero; and
watchlist breadth against the S&P 500 on two scales. Closed by default — the grid is the product,
and four charts of once-a-day context would push 53 rows below the fold on every load.
**How:** decisions 0046 (Lightweight Charts 5.2.1, Apache-2.0) and 0047 (a matview, measured).
Migration `20260918120000` adds `market_history` over the full span of `market_context` with
`vix_ma20`/`vix_ma20_bars` and a unique index on `d`; the page reads the newest 126 rows as an index
scan and reverses them once. New `web/lib/chart-theme.ts` reads the resolved palette off the
document so charts follow the OS colour scheme with no toggle and cannot disagree with the cells
beside them; new `web/lib/market-history.ts` holds the chart catalogue, pure, next to the column
catalogue.
**Architecture impact:** the first dependency in `web/` that draws, and the second client component.
`check_web_boundary.sh` rule 2 is now "every module in `lib/` except `grid.ts`" rather than a list of
two filenames — the list went stale the moment `chart-theme.ts` existed, which is what allowlists
do. `VIX_BAND` duplicates a norm and is pinned to `config/norms.yml` by a test rather than trusted.
**What these charts refuse to do,** each for a reason already paid for elsewhere: they do not draw
`vix_ma20` before its 20th bar; they skip a missing session rather than bridging it, because a gap
is a missing FRED publication and not a flat day (decision 0034); and they draw a threshold line
only on VIX, the one series with a norm, because a line across a chart reads as a rule.
**Verified by:** `scripts/ci/run.sh` green at 91 checks, 0 failing, 7 goldens MISSING as expected,
with the new matview applied and populating (`vix_ma20_bars` 0 → 20, nulls before the window fills).
`deno test` 80 passing, including the VIX_BAND pin, negative-tested by drifting the band to 17 and
by renaming the constant. `npm run build` clean. Then the panel was read against a fixture of **126
real production sessions** (2026-03-19 → 2026-09-17, chosen because VIX peaks at 31.05 above the
norm, troughs at 14.25 below it, and term structure goes negative for five sessions in late March,
so all three regimes and the zero crossing are exercised) at 1280 / 1440 / 1680 / 1920 in both
themes, with an automated check that every chart box has a canvas, is wider than 200px, is not
blank, and does not make the body scroll sideways.

**Three defects were found before or on screen, and two of them were invisible to the build.**

A unit check on the fixture caught the first: `history.tsv` is pipe-delimited and the fixture reader
split on tabs, so every `vix` was `undefined` and all 126 sessions read as "unknown". It would have
rendered four blank charts and a plausible-looking page.

The regime strip was drawn in `--below-bg` and `--rule-soft` — cell *background* tints, near-white
by design. On a white surface the 91 inside sessions and 33 below sessions were indistinguishable
from the panel, and only the 2 above sessions showed: a chart built to show three regimes showed
one. A tint that works behind text does not work as a mark.

And the breadth chart clipped its own lowest axis label at the shared 8% bottom margin, because two
price scales and a time axis leave less room below the plot than one does.

## 2026-09-18 — The cell detail sheet shows five years
**What:** tapping a cell now draws that parameter's full stored history for that security, with the
norm band where there is one, under the value and the state the sheet already showed. A planned
column says no security has a value for it and draws nothing; a failed read says so and leaves the
current value alone, which came with the page.
**How:** decision 0048. **No migration** — `grid_cells` and `rs_cells` filtered by symbol *and*
param are already indexed reads (8.5 ms / 234 buffers and 8.7 ms / 87 buffers on production), so
the `grid_cell_history` view the plan budgeted was deleted by measuring it. New
`web/app/api/cell-history/route.ts` is the app's first server endpoint; `web/lib/cell-history.ts`
holds the allowlist it validates against, derived from `COLUMNS` so a parameter the grid does not
display cannot be requested.
**Architecture impact:** the first place in this repo where request input and the service_role key
meet. `check_web_boundary.sh` gains rule 5 — a route handler that reads the key must call
`validateRequest`, and must not put a request value on a line with a query — negative-tested by
removing the validator and by splicing `q.get("cols")` into the select list.
**Verified by:** the endpoint's contract, exercised end to end: a live param returns 200 with its
series, a planned param 404 with "designed and not built", an unknown param 400, a malformed symbol
400, a missing symbol 400. The sheet read at 1280 and 1920 in both themes — one chart per sheet,
canvas painted, 451px tall and inside the viewport at every width, loading state gone within 1.2s,
and a planned column drawing nothing while explaining why.
**Not verified, and stated rather than implied:** the norm band's position against a *real* series.
The preview shim serves one series for every param, so a bound at −25 sits off-scale under VIX
values of 15–31. The band is the same `createPriceLine` call already visible on the VIX chart; its
pairing with the right series gets checked on the deployed page.

**One check of mine was wrong and said so loudly.** The screenshot harness asserted one canvas per
history chart and reported seven. Seven is correct — Lightweight Charts stacks a canvas per pane,
axis and crosshair — so the assertion counted the wrong thing. Corrected to count containers, with
a second assertion that a container holding fewer than two canvases did not build.

## 2026-09-19 — The Deep Dive tab is a real strip, frame first
**What:** `/deep-dive` is no longer a placeholder. It renders one 420px analysis column per
security, side by side, with eight sections at identical heights on every name: price, three RSI
gauges, moving averages, price statistics, weekly, relative strength, fundamentals, forward look.
Five of the eight read real data today. The three that do not each say which of three different
things is blocking them, and an ETF's two fundamentals panels say something stronger — *not
applicable, permanent, not pending* — because an ETF has no income statement and never will.
**How:** decision 0049. **No migration and no new read.** The page calls the same `fetchGrid` the
Dashboard calls; Next's Data Cache is keyed on the request URL and shared across routes, so
whichever tab is visited first populates it. New `web/lib/deep-dive.ts` is the strip's catalogue —
pure, like `columns.ts` — and new `web/components/StockStrip.tsx` is the client component.
**Charts are deliberately not in this change:** 53 names × ~1,260 daily bars is ~67,000 rows and
cannot travel in a page payload, so the bars arrive next through a per-column route built on the
same allowlist as `/api/cell-history` (Bodhi chose this sequencing over one larger change).
**Architecture impact:** three things in `lib/deep-dive.ts` are checked at module load rather than
by review — a section naming a param the catalogue does not have, a blocked section whose sentence
is missing or has gone stale, and a sentence over 120 characters. The last one has a layout reason:
a panel renders once per column, so a paragraph there is a paragraph per security. New
`scripts/ci/check_strip_sections.sh` runs in the `web` job.
**Verified by:** measurement before screenshots, in a real browser, at 1280 / 1440 / 1680 / 1920 in
both themes against a fixture of real production rows. Every column exactly 420px and exactly the
same height, so sections line up across names; no body-level horizontal scroll at any width; the
column heading sticks when the frame is scrolled; the right scrim appears and clears. The RSI band
geometry was read off the rendered page: daily starts at 30% of the track and weekly at 40%,
because `rsi_weekly` is 40/70 in `config/norms.yml` while the other two are 30/70 — a hardcoded
30 would have drawn the weekly threshold ten points from where the colouring changes. Every gauge
marker sits within 2% of its own value. Each cell state resolves to a distinct ink in both themes,
by `getComputedStyle`, which is the only check that can see the 2026-09-18 class-with-no-rule
defect. The new CI check was negative-tested thirteen ways.

**Four defects in my own work, all found by measuring the rendered page rather than reading it.**
The section-state derivation marked the price chart *live* because it named `close`, a param that
is live while the chart is not. The `na`-before-`planned` ordering bug from the cell-state model
repeated one level up, so an ETF's Fundamentals panel read "blocked on the vendor add-on" when the
truth is that the question will never apply to it. A reserved 200px chart box and a "live section
with an unbuilt param" branch were both dead — neither could render, and both had CSS. And the
first version printed a 270-character explanation and a two-line description in *every* column: the
same arithmetic that turned a per-cell PLANNED tag into 312 of them on the Value preset. Constant
text now lives once, in the page footnote; descriptions are hover text on the headings.

## 2026-09-19 — The Deep Dive price panel draws its bars
**What:** the price section of every Deep Dive column is now a real chart. It reads its own bars
when you scroll to that column, opens on three months of candles, and offers 3M / 1Y / 5Y on daily
and 1Y / 3Y / 5Y on weekly. EMA21, SMA50 and SMA200 are drawn over the daily view and EMA21W,
SMA30W and SMA200W over the weekly one, always at full width and always with a gap where the
average does not exist yet rather than a value carried across it. Weekly shows **completed weeks
only**. Two of the eight sections remain unbuilt — Fundamentals and Forward Look — and the page
footnote now says so in two sentences instead of three.
**How:** decision 0050. **No migration and no new view.** New `web/app/api/stock-history/route.ts`
and `web/lib/stock-history.ts`, built on the same allowlist discipline as `/api/cell-history`, which
`check_web_boundary.sh` rule 5 enforces for both without a change.
**Measured rather than assumed, twice.** Letting Postgres join the bars to the averages costs
9.745 ms and 797 buffers for 260 NVDA rows — 780 of those buffers are a nested loop of index
lookups. Two flat index scans stitched by date in the handler cost 1.186 ms + 0.218 ms and 33
buffers: about a seventh of the time on a twenty-fourth of the buffers. That is decision 0048's
move applied to a join rather than to a view, and it went the opposite way to the intuition.
**A trap found before it was written:** `weekly_bars.is_complete` means "not the newest week for
this symbol", so it is false for the week in progress even on a Friday evening. Filtering it always
drops the newest week — which is correct here, because `weekly_features` computes its averages on
completed weeks and a candle one bar ahead of its own overlays would disagree with the Weekly panel
directly below it in the same column.
**Verified by:** measurement in a real browser before any screenshot. 6 of 22 columns fetch on
load, so the panel is lazy; the plot is 390px by 200px; a candle is **6.0px** at the opening view;
clicking 1Y and 5Y switches the mark to a line and back; the weekly toggle reports 125 completed
weeks ending a week before the daily series. Every column is 420px wide and **1473px tall, to the
pixel, across 1280 / 1440 / 1680 / 1920 in both themes** — including after one column's range is
changed. The new CI section was negative-tested three ways and the whole check thirteen.

**Three defects in my own work, and the first two were design errors the measurement exposed.**

1. **Panning could never reach the line.** The first build opened on a quarter and let you drag
   back through five years, with zoom off. Panning moves the window; it never widens it — so the
   line mark, which exists precisely for more bars than pixels, was unreachable through the
   interface. The CI check said it was reachable because it asked the rule for a large bar count
   instead of asking what the controls can produce. Both the panel and the check were rebuilt
   around explicit range buttons, which is also closer to what was asked for: "views".
2. **A drag inside a horizontally scrolling strip is ambiguous.** Pressing on a 390px canvas and
   moving sideways had two plausible meanings. Removing the pan removed the question.
3. **A wrapped caption broke the alignment the strip exists for.** At 5Y the caption ran to two
   lines, pushing that column's RSI panel 17px below every other column's. The caption now reserves
   two lines always, and the harness compares column heights *after* interacting, not only on load.
   The caption was also wrong: "3M of 627 sessions · 2024-04-25 → 2026-09-18" described the whole
   series beside a three-month label. It now reads "3M · 65 of 627 sessions to 2026-09-18".

**Not verified here, and stated rather than implied:** the browser check ran against a *synthetic*
series, shaped to match the real ALAB one read off production (627 bars, averages absent for the
first 20 / 49 / 199) because what it tests is geometry. That the route returns the right rows and
that `stitch` aligns them was answered in SQL against production, and gets answered again against
the deployed route after merge — the way the AVGO norm band was closed out on 2026-09-18.

## 2026-09-19 — Documentation brought back to what is true, and one legend defect
**What:** the orientation docs described a product that no longer exists. `CLAUDE.md` still opened
with "26 parameters across ~40 tickers" and its Current state listed relative strength, the market
block, the interface and hourly as **not built** — all but hourly had shipped. `README.md` said the
same. `GLOSSARY.md` defined a parameter as "one of the 26" and carried **two duplicated terms**
(*Searched column*, *Not applicable*). `CODEMAP.md` drew two matviews where there are four.
`PROPOSAL.md` still scoped the product at 26 × 36.

**Also one real defect, found by the verification owed from #82.** Checking the deployed
`/api/stock-history` against the database showed ALAB's weekly `sma200w` coming back as an empty
array — correct, it has 130 completed weeks and a 200-week average needs 200 — while the chart's
legend went on listing **SMA200W** beside a line that was not drawn. ARM and SNDK are the same.
The key is now struck through with the reason on hover, rather than dropped: three names with a
two-entry legend and no explanation would be worse than the bug.

**And a number that was wrong in several PR bodies.** The Value preset is **26** columns, not 27:
20 fundamentals plus 6 forward. The two sector ranks are fundamentals-sourced but live in the
Relative group, outside that preset. Counted from the catalogue rather than carried forward again.

**How:** decision 0051. `PROPOSAL.md` takes a **v3** revision rather than a silent edit, because
going 36 → 53 securities and 26 → 51 catalogue columns with a second tab is a scope change and
decision 0024 says a scope change earns a revision entry. `ONBOARDING.md` gains a step 2b pointing
at the current state *before* the spec, and two new comprehension questions.

**What was deliberately NOT touched:** `DECISIONS.md`, `FEATURES.md`, `INCIDENTS.md` and the dated
row in `CONSTRAINTS.md` all say "36 names" and all of them are **right** — they are dated records
of what was true when written. Rewriting history to match the present is how a log stops being
evidence.

**Verified by:** every number in the rewritten sections measured first — 53 securities / 10 ETFs /
9 themes / 3 indices and 15 norms from the database, 51 columns / 22 live / 28 with an `applies`
rule and the preset sizes from the compiled catalogue, 63,579 equity bars over five years and
8,063 index rows over eleven from `daily_bars`, four matviews and four cron jobs from the catalog
tables. The Value-preset count is what that pass caught. Cross-checked afterwards that no two docs
state a different figure for the same thing.
