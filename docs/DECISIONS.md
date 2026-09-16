# Decisions

Append-only. Newest last. Each entry: what we decided, why, what we rejected.
Written **before** building. For what got built, see `FEATURES.md`.

---

## 0001 — 2026-09-12 — Supabase is the data plane, not just storage
**Decided:** all market-data fetching runs inside Supabase (edge functions / pg_net), with
signals computed as SQL. **Why:** AI coding sandboxes have no network route to any market-data
provider; Supabase's network does. **Rejected:** fetch scripts running where we write code
(fails at the proxy), and a separate worker service (more infrastructure for no gain).

## 0002 — 2026-09-12 — Rules and norms are data, not code
**Decided:** setups and colour thresholds live as JSON/YAML rows, evaluated by an engine that is
a pure function of `(ticker, date)`. **Why:** makes backtesting free — replay is the same code
with the date argument opened up — and lets us tune thresholds without a deploy.
**Rejected:** imperative rule logic, which would need a second implementation for replay.

## 0003 — 2026-09-12 — No paid data feed in v1
**Decided:** keyless sources only (Yahoo chart + SEC XBRL), with analyst figures via Claude web
search. **Why:** free, and SEC gives genuinely point-in-time fundamentals. **Rejected:** a paid
estimates feed (~$30–80/mo) — revisit once we know whether we actually read the searched column.
**Mitigation:** a provider interface so a paid feed drops in without touching anything downstream.

## 0004 — 2026-09-12 — No score and no ranking in v1
**Decided:** colour against norms we define; no composite score, no ordering.
**Why:** a ranking implies an edge we have not proven. **Rejected:** a weighted score — deferred
until we have watched real data for a few weeks.

## 0005 — 2026-09-12 — Desktop-first, with an email digest as the phone surface
**Decided:** full grid on desktop web; a daily email digest for the phone; a deliberately thin
mobile view for checking one name. **Why:** 26 columns across 36 names is an information-density
problem no responsive layout solves. **Rejected:** a PWA (only pays off if the phone is a
scanning surface, which it isn't) and Slack (adds a workspace dependency; email is archivable).

## 0006 — 2026-09-12 — Extremes measured on intraday highs and lows
**Decided:** all-time and 52-week extremes use true highs/lows, not closes. **Why:** the
all-time high is the highest price actually traded; for MU that is $1,255.00 vs $1,213.56 on
closes. **Rejected:** close-based extremes, which understate every "% off high" threshold.

## 0007 — 2026-09-12 — Technicals anchored to TradingView
**Decided:** match TradingView's Pine definitions exactly for RSI, EMA and SMA; define
realized volatility and relative strength ourselves and say so. For fundamentals, match
ourselves consistently and note the divergence. **Why:** TradingView publishes its formulas, so
they are reproducible; consumer apps buy adjusted vendor fundamentals we cannot reproduce.
**Rejected:** chasing Robinhood's fundamentals, which use non-GAAP earnings.

## 0008 — 2026-09-12 — Public GitHub repo
**Decided:** public repo on GitHub Free. **Why:** protected branches, unlimited Actions minutes
and free secret-scanning push protection are all free on public repos and paid on private ones.
**Rejected:** private on Free (no branch protection — the harness could not enforce anything)
and GitHub Pro (revisit if we want privacy later). **Accepted risk:** going private later does
not unpublish history, so secret discipline is non-negotiable from the first commit.

## 0009 — 2026-09-12 — The prototype is reference-only; this repo rebuilds clean
**Decided:** the throwaway Supabase project keeps running as a reference, but this repo rebuilds
from numbered migrations. **Carries over:** the verified indicator formulas and golden values
(`DEFINITIONS.md`), and everything in `CONSTRAINTS.md`. **Does not carry over:** the prototype's
ad-hoc SQL, its 20 draft rules, and its Vercel-managed Supabase org.
**Why:** the prototype's schema grew by accretion with no migration history, and a look-ahead bug
in its weekly join was only caught late — it is not a base to build on. Its org also cannot
cleanly invite a collaborator.
**Rejected:** porting the prototype SQL wholesale, which would import both the accretion and the
habit that produced the look-ahead bug.

## 0010 — 2026-09-12 — PROPOSAL is the frozen spec; FEATURES is the record of what exists
> **Amended by 0024 (2026-09-13): "frozen" became "versioned".** The split below still holds and is
> the important half — what the product *is* versus what exists are different documents, and a
> feature shipping is never a reason to edit the spec. What changed is that a genuine change of
> SCOPE now earns a numbered revision with an entry in PROPOSAL's revision history, rather than
> leaving the most-read document in the repo permanently describing a product we decided against.
**Decided:** `PROPOSAL.md` is edited only when **scope** changes. What actually got built, and
how, is recorded in `FEATURES.md`. **Why:** both documents otherwise end up describing the same
system, drift apart, and nobody knows which is true. **Rejected:** keeping the proposal current
as living documentation — that makes it a second, competing description of the codebase.
**Practical rule:** if a PR changes what the product *is*, update the proposal. If it changes
what *exists*, update FEATURES.

## 0011 — 2026-09-12 — Coarse `theme` for ranking, granular `tag` for display
**Decided:** seven themes sized 4–7 members, plus a `tag` field used only for display. Themes
that are not genuine peer groups (`diversified`, `foundry-analog-ip`) carry `rankable: false` and
return **null** for sector-relative ranks. **Why:** the original 25 themes left 16 singletons, so
sector-relative rank was meaningless for 32 of 36 names — a lone member always ranks at the 100th
percentile of itself. Coarsening lifts usable ranks from 4 names to 24. **Rejected:** forcing all
36 into rankable buckets, which would have produced a confident number comparing a bank's FCF
yield to a health insurer's. A null is honest; a fake rank is not.
**Enforced:** CI fails if a `rankable: true` theme has fewer than three members.

## 0012 — 2026-09-12 — Ship the first-guess norms, tune from real data
**Decided:** launch with the 17 thresholds in `config/norms.yml` as written. **Why:** they are
first guesses and we know it, but staring at a blank sheet tunes nothing — a week of real data
tells us more than another hour of argument. **Known weakest, in order:** `rsi_weekly` low = 45
(loose; will shade much of the sheet, which makes colour meaningless — 40 is probably right);
`close_vs_sma200d` high = 40 and `close_vs_ema21w` high = 20 (invented, no basis); `fcf_yield`
2%/8% (sector-blind — may need to become a percentile against the stock's own history, which
would be a definition change, not a threshold change). **Revisit:** after one week of live data.

## 0013 — 2026-09-12 — Onboarding, code map and comment discipline are documented and enforced
**Decided:** `ONBOARDING.md` (read order + comprehension check), `CODEMAP.md` (where code lives,
data flow, invariants) and `CODE_STYLE.md` (comment the why; mandatory headers on migrations and
functions). CI rejects a migration without a purpose header. **Why:** almost every file here will
be written by one stateless session and next read by a different one — the reader is always a
stranger, which inverts the usual cost/benefit of commenting. **Rejected:** relying on CLAUDE.md
alone; it loads every turn so it has to stay short, and detailed KT does not fit in it.

## 0014 — 2026-09-12 — One canonical hygiene checklist; everything else points to it
**Decided:** `docs/HYGIENE.md` holds the change-type → required-updates matrix, the branch and
commit conventions, the rules for concurrent sessions, and the definition of done. `CLAUDE.md`,
`ONBOARDING.md`, the PR template and CI **reference** it rather than restating it. **Why:** the
"log before finishing" list had already been copied into four files within a day; with five
contributors over months it would have drifted into four different rules. **Rejected:** keeping
the list in `CLAUDE.md` — it must stay short, and a matrix does not fit. **Also decided:** the
CI log gate is now precise — code requires a FEATURES/INCIDENTS entry, a norm change requires a
DECISIONS entry, docs-only PRs are exempt — because a blunt gate gets satisfied with junk
entries, which is worse than no gate.

## 0015 — 2026-09-12 — MIT licence
**Decided:** MIT. **Why:** the repo is public and has a second contributor, who needs
unambiguous rights to use and modify the result; there is no alpha to protect — the rules are
standard technical analysis; and MIT is the licence every developer already understands.
**Rejected:** no licence (all rights reserved by default, which blocks even the collaborator);
Apache-2.0 (a patent grant irrelevant to a dashboard); a non-commercial licence (only matters
if we'd object to someone else running this, which nobody has suggested).



## 0016 — 2026-09-12 — Migrations deploy via the Supabase GitHub integration; timestamp naming
**Decided:** the project is linked to the repo, so migrations under `supabase/migrations/` are
applied by Supabase when merged to `main`. Files are named `<YYYYMMDDHHMMSS>_<name>.sql` because
that is the format the integration recognises. **Why:** it makes "a human merged the PR" the
confirmation for a schema change, which is strictly stronger than an in-session yes — Claude
never applies a migration at all. It also keeps `supabase_migrations.schema_migrations` as the
single record of what is applied. **Rejected:** applying via MCP/CLI after review (the
integration then sees an unapplied file with a different version and errors), and unlinking the
integration (loses the audit trail for no gain). **Consequence:** never apply a migration by a
side route. The `run-migration` skill says so.
**Also decided:** "automatically expose new tables" is revoked in the first migration rather
than toggled in the dashboard — a setting in code is a setting the next session can see.
\n

## 0017 — 2026-09-12 — Ingest: one function, service-role bearer, deactivate never delete
**Decided:** a single edge function `ingest` with `?scope=tickers|daily|hourly|all`, callable
only with the project's service_role key as the bearer (constant-time compared inside the
function, on top of the gateway's JWT check). Symbols removed from `watchlist.yml` are set
`active=false`, never deleted. A symbol with no bars gets the full range automatically, capped
per run. **Why:** the function URL is derivable from a public repo and each call is ~80 Yahoo
requests on our egress, so it needs a real lock, and the service_role key already exists in
the runtime and in Vault — no new secret to rotate. Deactivating rather than deleting is because
`daily_bars` cascades on delete: a one-line yml edit must not erase years of history. The
automatic catch-up is what makes "add a line, commit" the whole procedure for a new ticker.
**Rejected:** a separate `INGEST_SECRET` (one more secret for marginal gain, since pg_cron runs
inside the same project); no auth (public URL); one function per scope (three deploys sharing
one provider); deleting stale tickers (data loss for a config edit).
**Also decided:** edge functions use `npm:` and `node:` import specifiers, not `jsr:`, because
jsr.io is blocked from the coding sandbox and the npm registry is not — tests must run where the
code is written (CONSTRAINTS.md 2026-09-12).

## 0018 — 2026-09-13 — Every migration grants explicitly; the ingest role cannot delete
**Decided:** a migration that creates a table also writes its own `grant` line for whichever
role needs it. No `alter default privileges ... grant` anywhere. The ingest identity
(`service_role`) gets `select, insert, update` and **not** `delete`. **Why:** Supabase's
permissive defaults belong to the `supabase_admin` role, and a migration runs as `postgres`, so
nothing is granted automatically on a table we create — we found this the hard way
(INCIDENTS.md 2026-09-13). Given that we must grant somewhere, granting per table keeps the
reader's question "who can touch this?" answerable from the migration that created it, which is
the same reason anon was revoked in the first place. Withholding `delete` turns decision 0017's
"deactivate, never delete" from a code-review promise into something Postgres enforces — bars
cascade on a ticker delete, so the blast radius of a bug there is years of history.
**Rejected:** default privileges for `service_role` (restores the silent-exposure pattern we
removed for anon, just aimed at a different role); defaults *plus* redundant explicit grants
(two sources of truth that drift, and the explicit line stops carrying information).
**Consequence:** forgetting a grant breaks the next ingest at runtime and CI cannot catch it.
Accepted knowingly: the check lives in `docs/CODE_STYLE.md`'s migration checklist, and
`ingest_runs` makes the failure loud.

## 0019 — 2026-09-13 — Prices from Polygon, indices from FRED; Yahoo abandoned
**Decided:** replace keyless Yahoo with two keyed sources — **Polygon** (rebranded to
massive.com) for the 36 equities, **FRED** for `^VIX`, `^VIX3M` and `^GSPC`. Both free tiers.
`^SOX` and `^NDX` leave the watchlist, and the `rs_vs_sox_6m` norm with them.
**Why:** a single 90-request burst earned Supabase's egress IP a `429` from Yahoo that was still
in force 4.5 hours later and on a second host (INCIDENTS.md 2026-09-13). A keyless endpoint on a
shared cloud IP is not a foundation — the key identifies us instead of the IP, and the limit is
published rather than discovered by being punished.
**Why these two:** the criterion was that the *paid* tier should be the natural next stage as the
watchlist grows and updates get more frequent. Polygon Starter at $29/month makes API calls
**unlimited**, so more names and more frequency cost nothing extra; Twelve Data ($79) and FMP
($59 for intraday) both meter per-minute credits, so growth costs more on exactly the axis we
expect to grow. FRED is the Federal Reserve: free, official, documented, and the only free
source found that carries the 3-month VIX, without which there is no term structure and no
"the market is peaking" signal.
**Rejected:** Twelve Data (usable free tier, but $79 next step and credit-metered);
FMP (free tier is end-of-day only, intraday starts at $59); Tiingo (no index feed at all, so no
VIX); EODHD (excellent $19.99–$29.99 ladder and 100k calls/day, but its free tier is 20 calls a
day and one year of history, so we could not start free); moving fetching to GitHub Actions
(dodges the IP problem but splits the architecture and keeps us on an unofficial endpoint);
waiting for Yahoo to relent (four and a half hours of evidence says it will not).
**Consequences, all of which are recorded where they bite:**
- Polygon free gives **2 years** of history, so "% off all-time high" is bounded by what we
  store. INTC, QCOM and GE peaked in 2000 and their true highs are outside every tier we would
  plausibly buy. DEFINITIONS.md §Price behaviour says so rather than mislabelling the column.
- Polygon is **split-adjusted, not dividend-adjusted** — the same basis as Yahoo's `close`, so
  the golden values survive the switch. Now written down as DEFINITIONS.md §4a instead of being
  an accident we relied on.
- **5 requests/minute** means a backfill cannot finish inside one edge-function lifetime, so
  runs are batched and `deferred` carries the remainder. Polygon's grouped-daily endpoint would
  make the incremental path one call instead of 36; noted, not built.
- Hourly bars are **not** implemented on the new provider. Polygon's hour aggregates align to
  clock hours and include extended trading; TradingView aligns to the 09:30 session. Rolling
  minute aggregates into session-aligned hours is the right fix and gets its own PR, because
  hourly RSI is read against a 30/70 threshold and bar alignment moves it.
- `^SOX` was dropped rather than proxied with SOXX. A proxy would have meant computing one thing
  and labelling it another, which is the failure mode this project spends most of its effort
  avoiding. `^NDX` followed because once `rs_vs_sox` was gone, no parameter consumed it.
**Also decided:** `BarProvider` grows `supports()` and `minIntervalMs`. Routing belongs to the
provider (FRED claims `^` symbols, Polygon claims the rest, and a symbol nobody claims fails the
ticker sync loudly), and pacing is a property of the provider's published plan rather than a
constant in the ingest loop that someone tunes by feel.

## 0020 — 2026-09-13 — The parameter layer is SQL: a materialised view, recursion in PL/pgSQL
**Decided:** parameters are computed in SQL, next to the data, as a materialised view refreshed
after each ingest. The recursive indicators (Wilder's RMA, and therefore RSI, plus EMA) live in a
PL/pgSQL set-returning function invoked once per symbol; everything non-recursive is a window
function. A value below its **window** is null; a value below its **seed-decay floor** is
published alongside a boolean flag rather than nulled.
**Why SQL rather than TypeScript in the ingest:** the formulas would then live in the fetcher,
one layer away from `DEFINITIONS.md` and in a language where nothing forces them to be re-derived
per date. Decision 0002 requires parameters to be a pure function of (ticker, date) so that a
backtest is a `WHERE` clause; a fetcher naturally computes only the latest value, and the second
implementation for history is exactly the drift we are avoiding.
**Why materialised rather than a plain view:** the recursion is O(n) per symbol and a plain view
would redo it on every grid read. The cost is honest and immediate — a matview is a cache, so
`refresh materialized view public.daily_features` is now a required step that **nothing performs
automatically yet**. `scripts/verify_parameters.sql` has a freshness check whose only job is to
catch that, because "stale cache" is the same failure family as the deploy toggle and the no-op
revoke (INCIDENTS.md): an operation that succeeded and changed nothing.
**Why PL/pgSQL rather than a recursive CTE or a closed-form window function:** the closed form for
an EMA divides by `(1−α)^i`, which over 494 bars at α = 1/14 reaches 7.7×10¹⁵ — it would bleed
precisely the precision the golden values are asserted to (1e-3 absolute, against observed
agreement of 2.4×10⁻⁵). A loop is exact, and it puts Wilder's smoothing in one commented place a
reader can check line by line against `DEFINITIONS.md` §1. The function is called once per
**symbol**, not once per row: in the join condition it would have run 19,000 full-history scans
instead of 39.
**Why publish-below-the-seed-floor with a flag rather than suppress:** hard constraint 8 says
suppress a seed-influenced value, and this layer does not — it sets `rsi_daily_seed_ok` /
`ema21_seed_ok` to false and leaves the number. Suppression is a display judgment (a backtest may
legitimately want the converged-ish value, and a null cannot be un-nulled), but the *floor* must
not be a display judgment, or it ends up re-derived in the grid, the digest and the rule engine
and drifts between them. The floors are written in the migration and asserted against
`DEFINITIONS.md` §4 by the verify script.
**Rejected:** computing in the ingest function (above); a plain view (recomputes the recursion on
every read); a recursive CTE (correct but the state threading is unreadable next to a loop, and it
still needed the same seeding logic); nulling below the seed floors in the view (loses data
irreversibly and hides the floor inside SQL nobody reads); a `numeric` rather than `double
precision` accumulator (exactness we cannot use — the external anchor is a hand-read TradingView
figure, and float64 already agrees with it to 1e-5).
**Consequences:** the grid, the digest and the rule engine all read one view, and a backtest reads
the same view with a date filter. Every parameter that needs weekly bars, an index, or a
cross-sectional rank is *not* in this view yet and gets its own PR. And the refresh is a hand
operation until the pg_cron work lands — the freshness check is the guard rail in the meantime.

## 0021 — 2026-09-13 — Paid the $29 Polygon tier; the per-run cap now comes from the wall clock
**Decided:** subscribe to Massive (Polygon) **Stocks Starter, $29/month** — unlimited calls, 5
years of history, flat files included. `FULL_DAYS` goes 720 → 1800, `MIN_INTERVAL_MS` goes
12,500 → 200, and the per-run symbol cap splits into two defaults chosen by the cost of the work:
45 for an incremental top-up, 15 for a full backfill.
**Why now:** the 200-week SMA is one of the 26 parameters and **cannot be computed at all** on two
years of history — zero of 36 names had 200 weekly bars, with 103 the ceiling. Five years is ~260
weeks, so this purchase fixes a measured gap rather than buying speculative headroom. It also
lifts the weekly golden-value agreement from ~4×10⁻⁴ toward the daily layer's ~1×10⁻⁵, because the
recursive seeds get 2.5× more room to decay. Separately, the free tier was arithmetically finished
at the ~200-ticker scale we are heading for: 5 requests/minute is a 40-minute sweep against a
150-second function lifetime.
**Why the pacing is 200 ms and not 0:** "unlimited" is a billing statement, not a promise about
burst behaviour. 90 requests in 6.9 seconds is what got Supabase's egress IP blocked by Yahoo for
longer than 4.5 hours (INCIDENTS.md, decision 0019). 200 ms is 5 requests/second, keeps a
39-symbol sweep at 8 seconds and a 200-symbol sweep at 40, and there is nothing to gain from going
faster and a whole provider to lose.
**Why two default limits instead of one:** a full fetch is roughly 50× the payload of a top-up. One
shared default either throttles every routine refresh or gets a backfill killed halfway, and a run
killed by the wall clock loses every per-symbol error it had collected — which is how the first
live attempt became an unexplainable "504". Making the default follow `full=1` means nobody has to
remember. `planLimit()` is pure and tested, so collapsing them back into one constant fails a test.
**Why `offset` is manual, and what was rejected:** when the history depth increases, every symbol
already has bars, so `full=1` marks all of them "full" on every run — a sliced run would redo the
same first N forever, because the plan order is stable and nothing distinguishes "already
deepened" from "not yet". The rejected alternative was automatic depth detection, re-fetching any
symbol whose earliest bar is later than the window allows. It cannot work without recording state:
a symbol that simply **listed** later (SNDK, 2025-02-13) is indistinguishable from one not yet
deepened, and would be re-fetched on every run forever. Recording that state means a schema column
for a one-time operation. `offset` is three lines and the operator can see what it did.
**Also rejected:** Polygon Developer at $79 (10 years — we have no parameter that reaches past 5);
Indices Starter at $49 (VIX on FRED is free and carries 1990 onward against the Indices plan's ~1
year); EODHD at $29.99, which genuinely beats this on history-per-dollar (30 years EOD, 20 years of
1-minute) but appears to put indices in its $99.99 package and would cost a rewrite of the ingest
layer to buy history no parameter uses yet; Alpaca free, which is **IEX-only** so every volume
ratio would measure a few percent of true volume.
**Consequences:** flat files are now available and **not used** — at 39 symbols the per-symbol loop
is fine; it becomes the right answer near 200, where the loop is what breaks. A re-backfill is
required before any of this shows up in the data, and the depth must be verified from the earliest
stored bar rather than the billing page, because an over-wide date range may be silently truncated.
`% off all-time high` stays bounded and stays named `pct_off_high_stored`: INTC, QCOM and GE peaked
in 2000, outside every tier we would plausibly buy.

## 0022 — 2026-09-13 — One daily clock at 22:30 UTC, and the refresh is its own job
**Decided:** two pg_cron jobs. `swing-ingest-daily` at `30 22 * * 1-5` calls the ingest function;
`swing-refresh-features` at `45 22 * * 1-5` runs `refresh materialized view concurrently
public.daily_features`. No user-led refresh exists, so **these two jobs are the entire data
pipeline**.
**Why a fixed UTC time is not a DST bug:** pg_cron 1.6 has no per-job timezone and runs in the
server timezone, which is UTC. 22:30 UTC is 18:30 ET in summer and 17:30 ET in winter. Both are
comfortably after the 16:00 ET close plus the vendor's 15-minute delay, and *that* — the last daily
bar being settled rather than partial — is the property that matters, not hitting a particular
local minute. One fixed entry is therefore correct year-round. **Rejected:** month-guarded
duplicate schedules, which buy nothing and break quietly in March and November.
**Why the refresh is separate rather than chained:** chaining would guarantee it only runs on fresh
data, but it would collapse two failures into one silence — an ingest killed by the wall clock
would leave the matview untouched with no independent signal. Separate jobs mean a failed ingest
still lets the refresh run and the freshness check reports the gap honestly. Two visible failures
beat one silent one. The 15-minute gap is enormous margin against a ~5 s run, and margin is free.
**Why CONCURRENTLY:** a plain refresh takes an ACCESS EXCLUSIVE lock and blocks every dashboard
reader. Verified 2026-09-13 that the concurrent form is permitted inside a transaction block, which
pg_cron requires, and `daily_features` already has the unique index it needs.
**The limitation, recorded because a green log will otherwise be believed:** pg_net's `http_post`
is fire-and-forget. `cron.job_run_details` records SUCCESS when the request is **queued** — not
when the HTTP call completed, and not when the ingest succeeded. The authoritative signals are
`ingest_runs`, then the freshness check, then cron. This is the same "operation is not the outcome"
shape as the deploy toggle, the unapplied migration and the no-op revoke (INCIDENTS.md).
**No retry, deliberately.** One run a day; a failure means a stale day. A second evening run was
offered and declined, and re-running would have been safe — the upsert key is (symbol, d) and the
pipeline is idempotent. The compensating control is that staleness must be **visible on the
dashboard**, which makes the freshness stamp and the staleness banner requirements of the grid
rather than nice-to-haves.
**Secrets:** `cron.job.command` stores a Vault *lookup*, not a key. Verified against a stub that the
stored command contains no secret value. This matters because the repo is public and `cron.job` is
readable by anyone who can read the database.

## 0023 — 2026-09-13 — Norms are compared in SQL, and the grid is long format
**Decided:** `config/norms.yml` syncs into `norms` and `flags` tables exactly as `watchlist.yml`
syncs into `tickers`, and the comparison that turns a number into a verdict happens in the
`grid_cells` view. The view returns one row per (symbol, date, parameter) rather than a column per
parameter.
**Why SQL and not the website:** a norm is the only opinion this product expresses, and three
things will need it — the grid, the email digest, and the Phase 2 rule engine. Written in the
website it gets written three times and drifts. Written once in SQL, "was this cell red on
2024-03-12" is a WHERE clause over history, which is decision 0002's argument applied to verdicts
instead of parameters. **The cost, accepted:** editing the yml no longer takes effect instantly, it
takes effect on the next sync. The sync runs daily and can be fired by hand, and the yml stays the
only thing a human edits.
**Why long format:** the verdict logic is then one CASE expression instead of twenty-six
near-identical ones, and adding a parameter is one line in the unpivot rather than a column plus a
verdict column. The dashboard pivots in JavaScript, which is trivial. Rejected: a wide view, which
reads better in psql and is worse everywhere else.
**The distinction the view is built around:** `verdict` is null both when no norm is defined and
when the value is suppressed for warm-up, and `has_norm` / `suppressed_warmup` tell them apart.
Collapsing "we have no opinion" into "normal" would be the worst available bug here — it would
paint twelve un-normed parameters as actively fine. Today only **4 of 16 norms** have a parameter
that exists; the other 12 wait on the weekly layer, market context or fundamentals.
**Renamed `pct_off_ath` to `pct_off_high_stored`.** Norms match parameters BY NAME, so the old key
would have matched nothing and coloured nothing, silently and forever. The parameter keeps the
honest name because five years is not all time — INTC, QCOM and GE peaked in 2000.
**Deliberate exception to decision 0018:** `service_role` gets DELETE on `norms` and `flags`, which
0018 withholds everywhere else. 0018's reasoning was blast radius — `daily_bars` cascades and holds
years of unre-fetchable history. These are caches of a file in git, and delete is genuinely
required: a norm removed from the yml must stop colouring its cell, as `rs_vs_sox_6m` was in
decision 0019. The deactivate-never-delete pattern does not transfer, because a stale ticker merely
sits inactive while a stale norm keeps painting. The guard is in `norms.ts`: an empty parse throws
rather than wiping the table.
**Also decided:** staleness is judged in `grid_status`, not in the frontend. With one scheduled run
a day, no retry and no refresh button, the realistic failure is ten people reading silently stale
numbers, so the page must be unable to hide it. `last_run_ok` and `is_stale` are deliberately
separate columns — a run can succeed and the data still be a day behind.

## 0024 — 2026-09-13 — PROPOSAL.md is versioned, not frozen; v2 issued
**Decided:** `docs/PROPOSAL.md` carries a revision number and a revision-history table, and is
rewritten when the product surface genuinely changes. It is **not** a historical artefact to be
preserved unedited. v2 is issued today.
**Why:** the change matrix already makes PROPOSAL the single file a scope change may touch, and
`ONBOARDING.md` sends every new session there for 20 minutes to learn what the product is. A
document with that job cannot describe four clocks, a "Refresh now" button, two RLS-enforced roles
and a keyless Yahoo feed when none of those exist — a new contributor would build against it, and
the contradictions were already being discovered one at a time in other files. Freezing a spec
preserves the wrong thing: it preserves the words instead of the intent.
**What v2 changes**, each already decided elsewhere and merely now reflected: the price vendor and
the $29 plan (0019, 0021); five years of history rather than "full listing history", and the
consequences for the extremes columns; one clock rather than four (0022); no user-led refresh and
no login, with staleness on the page as the compensating control (v1 scope, 2026-09-13); norms
compared in the database (0023); hourly bars built from minute data rather than fetched; `rs_vs_sox`
dropped (0019); `pct_off_ath` renamed (0023).
**Why a revision table and not just git:** git holds the diff, but a new session reads the file, not
the log. The table answers "what would surprise me if I last read v1" in twenty seconds, which is
the question a reader of a rewritten spec actually has.
**Rejected:** leaving PROPOSAL frozen and recording drift only in DECISIONS — which is what we were
doing, and it meant the most-read document was the least accurate. Also rejected: deleting the
superseded text outright. The revision table keeps what changed visible, because "we used to think
we needed four clocks" is context, and the reasoning for dropping each one is why the next person
should not propose it again.
**Consequence:** ONBOARDING now sends readers to the revision table first, and adds two
comprehension questions covering the two assumptions most likely to be imported from the old
version — that a viewer can refresh, and that a green scheduler run means data arrived.

## 0025 — 2026-09-13 — The dashboard renders on the server; the browser never touches Postgres
**Decided:** `web/app/page.tsx` is a server component that reads through **PostgREST over HTTP**
with the `service_role` key and ships HTML. There is no client-side data fetching, no Supabase
client in the browser, and no `NEXT_PUBLIC_` variable carrying anything but a URL. Responses are
cached for 15 minutes.
**Why the server and not the browser:** the page is open with no login (v1 scope), so a browser
that queried Postgres directly would need RLS policies granting `anon` read on a schema that is
public in this repo. Getting one of those policies subtly wrong is a permanent, silent exposure.
Rendering on the server means **RLS stays deny-by-default with no read policy at all** - there is
nothing to get wrong. That is less work than the authenticated design, not more.
**Why PostgREST over HTTP and not a Postgres connection:** ten readers on multiple devices hitting
serverless functions that each open a connection is how a free-tier pool is exhausted. HTTP has no
such limit and the response is cacheable, so all ten are served from one upstream read.
**Why 15 minutes:** the data changes once a day. This bounds staleness rather than managing load -
ten readers would not trouble the database. Next requires the value to be a literal it can
statically analyse, so it appears twice; a type assertion fails the build if the two drift.
**Why nothing in the data layer throws:** CI builds this with no environment at all and must not
fail, and a thrown error in a server component is a 500 for every viewer - strictly worse than a
page that says what is wrong. A missing variable or an unreachable host renders a panel naming the
failing request and host. It deliberately does **not** fall back to a cached copy: a stale grid
shown without saying so is the exact failure the freshness work exists to prevent.
**Rejected:** a client-side Supabase client with `anon` + RLS read policies (the idiomatic Supabase
shape, and the one that puts a permanent exposure one bad policy away); a direct Postgres
connection from the server (connection-pool exhaustion at ten readers); static generation without
revalidation (the page would silently show build-time data forever).
**The hazard this decision is arranged around, stated plainly:** Next inlines every
`NEXT_PUBLIC_*` variable into the browser bundle at build time. The service_role key is a
full-access credential and this repo is public, so a single wrong prefix would be an irreversible
leak. The variable is therefore named `SUPABASE_SERVICE_ROLE_KEY` with no prefix, `lib/grid.ts`
says so at the top, and the PR verified it by building with a sentinel value and grepping the
client bundle for it.

## 0026 — 2026-09-13 — Staleness measures the pipeline, not the calendar
**Decided:** `grid_status.is_stale` is true when the **daily ingest has not completed successfully
within `pipeline_stale_after_hours`** (default 30). It is no longer derived from the gap between
today and the newest bar. `data_through` and `days_behind` are still published, as facts, but they
are not the verdict.
**Why:** the original test tolerated a Friday-to-Monday gap exactly, so the first public holiday
would have fired the banner on perfectly healthy data — Friday's bar, a closed Monday, and
Tuesday's check reading four days. **A banner that lies once is ignored forever after**, and its
entire job is to be believed on the day something actually breaks. Ten people read this page and
none of them can refresh it, so a false positive is not cosmetic; it is the failure of the feature.
**Why hours rather than days:** the schedule is daily, so "a cycle was missed" is naturally measured
in hours. A day-granular threshold cannot tell "ran late last night" from "did not run at all".
**Why only runs that fetched bars count:** a `scope=tickers` run syncs the watchlist and the norms
and reports ok=true without touching a price. Counting it would let a config sync mask a week of
failed price ingests. The filter is on the run's detail carrying a `daily` section, which only the
bar-fetching path writes.
**Why `last_run` and `last_success` are both published:** they answer different questions, and the
difference between "nothing has run" and "it ran and failed" needs different fixes.
**Rejected:** counting weekdays instead of calendar days (closer, but still wrong on holidays —
it trades a wrong answer four times a year for a wrong answer nine times a year in the US); a
hard-coded market calendar (a dependency and a maintenance burden for a question we can answer
without one); and simply raising the threshold to 4 days, which buys silence about real failures
for a day and still breaks on a Thursday-Friday holiday pair.
**Verified against seven scenarios** rather than reasoned about, including the two that matter:
a Monday holiday with a healthy cron reads **fresh**, and a config-only sync an hour ago does not
stop a 40-hour-old price pipeline reading **stale**.

## 0027 — 2026-09-13 — The digest reports crossings, and says nothing when nothing crossed
**Decided:** a `digest` edge function sends one plain-text email per weekday, built from two views.
`digest_changes` lists cells whose norm verdict differs from **that symbol's own previous stored
date**; `digest_standing` lists everything currently outside a norm. Recipients live in a Supabase
secret, not in config. The function is **not scheduled by this decision** - see below.
**Why a query rather than a change log:** `grid_cells` holds every date (decision 0002), so "what
changed today" is answerable without recording anything at the moment of change. Nothing can be
missed by a job that did not run, and the same query answers "what changed on any past day" by
moving one filter. A log written by the ingest would be a second source of truth able to disagree
with the parameters it describes.
**Why compare to the symbol's own previous date** and not to a fixed yesterday: a symbol that did
not trade has no row. Partitioning by (symbol, param) makes holidays, halts and late listings need
no special case at all.
**Why both verdicts must be non-null:** a value crossing its *warm-up floor* is not news about the
market, and would otherwise announce itself once per ticker per indicator forever. The cost is
stated rather than discovered: the first time a young name's RSI becomes judgeable while already
below 30, the digest stays quiet.
**Why it reports recoveries too:** this tracker exists as much for trimming as for entering
(PROPOSAL §1). A position coming back inside its norm is exactly what otherwise goes unnoticed.
**Why a quiet day still sends an email saying so:** an email that only arrives on interesting days
cannot be distinguished from a broken pipeline. "Nothing crossed a norm today" is the product
working.
**Why a stale pipeline suppresses the digest entirely:** a cheerful "nothing crossed a norm today"
computed from three-day-old data is a lie, and the most believable kind. Stale means the email
leads with that and carries no market content at all - asserted by a test.
**Why recipients are a secret and not config:** the repo is public. The watchlist and the norms are
ours to publish; other people's inboxes are not.
**Why no retry:** retrying an email risks sending two, which is worse than sending none. One send
per run, failures recorded, next run tomorrow.
**Why this PR does not schedule it:** sending is irreversible and is a hard stop. The function ships
callable with `?send=0`, which renders the email and returns it without sending. The schedule is a
separate change made only after a dry run has been read.
**Also decided:** `auth.ts` moves to `supabase/functions/_shared/`, because an auth check is the
last thing that should exist in two copies that can drift. And `renderDigest` lives in its own
module rather than in `index.ts`, because `index.ts` calls `Deno.serve` at top level and importing
it from a test starts a real listener - the same trap already hit with the ingest function.

## 0028 — 2026-09-13 — The digest goes live: 23:00 UTC weekdays, two decimals
**Decided:** schedule `swing-digest` at `0 23 * * 1-5`, thirty minutes after the ingest and fifteen
after the parameter rebuild. And the digest reports values to **two** decimal places where the grid
shows one.
**Why the ordering is not arbitrary:** the digest reads `digest_changes` → `grid_cells` →
`daily_features`. Run before the refresh, it would compare today's bars against yesterday's
parameters and report changes that did not happen. 22:30 fetch, 22:45 rebuild, 23:00 send.
**Why two decimals, when the grid shows one:** the dry run exposed it. On 2026-09-11 QCOM moved to
**-29.99** against a norm of -30 and CAT left a -25 norm from **-25.0088**. At one decimal those
render as "-30.0 → back inside" and "-25.0 → was outside" - both verdicts correct, both lines
reading as self-contradictory. The grid *displays* a value; the digest *asserts that a value
crossed something*, so the digit the claim rests on has to be visible. A reader who doubts one line
doubts the whole email. The grid stays at one decimal because it is a scan of 360 cells where the
extra digit is noise rather than evidence.
**Why the digest still sends when the ingest failed:** it reads `grid_status`, sees the pipeline is
stale, and sends a short notice instead of a market summary. An email that simply stops arriving is
indistinguishable from a quiet market - the exact ambiguity the digest exists to remove. Suppressing
the send on failure would recreate it.
**Why the schedule is a separate migration from the function:** sending is irreversible. The
function shipped first, callable only by hand with `?send=0`, so a human read the real email before
anything could reach anyone. That sequencing is the control, not ceremony.
**Kill switch, written where someone panicking will find it:**
`select cron.unschedule(jobid) from cron.job where jobname = 'swing-digest';` - immediate, loses
nothing.

## 0029 — 2026-09-13 — The golden values are gated in CI, but not the ones you would expect
**Decided:** a `parameters` CI job stands up PostgreSQL 16, applies every migration in order to an
empty database, loads a **synthetic** fixture, and compares `daily_features` against values an
independent implementation computed from the same series. The build fails if any check does not
PASS. The **MU golden values remain a manual check against production.**
**Why the goldens cannot be gated:** reproducing them in CI means committing MU's price history.
The data plan is licensed for individual use, so 1,235 OHLC rows in a public repo is
redistribution. Four derived indicator values in `DEFINITIONS.md` are fine; a price series is not.
This is a licensing constraint, not a technical one, and no amount of engineering removes it.
**What is gated instead, and why it is the right thing anyway:** the FORMULAS. Whether our SQL
computes Wilder's smoothing, the EMA seeding, the window frames and the annualisation the way an
implementation written independently from DEFINITIONS.md does. That is the regression that gets
easy to introduce as the parameter count grows, and it is exactly what the MU goldens do *not*
test - they test the vendor's data and the adjustment basis. `DEFINITIONS.md` §6 already said
neither substitutes for the other; this makes that split structural.
**Tolerance 1e-9 relative**, against 1e-3 for the hand-read TradingView goldens. Both sides here
are float64 doing the same arithmetic in a different order, so anything past accumulation noise is
real. Measured on first run: RSI, EMA and SMA agree at **exactly 0.000e+00**; realised volatility
at 1.6e-16.
**Also gated, because a stub can prove it:** that the scheduling migrations register exactly three
jobs and that no scheduled command embeds a secret value rather than a Vault lookup.
**The one concession, stated so nobody discovers it later:** `create extension` lines are filtered
out, because pg_net and pg_cron do not exist outside Supabase and the first migration would fail
before anything could be verified. Those two lines are the only statements in the repo this gate
does not cover. Everything else is applied verbatim, in order.
**Rejected:** committing a real price series (licence); pointing CI at production (couples every PR
to live data and needs a full-access key in Actions); gating only invariants and skipping formulas
(the cheap half - invariants catch impossible values, not a wrong but plausible RSI).
**Two things this exercise caught in its own design:** an idempotency loop that "proved" every
migration could be re-applied - false, and correctly failing, because migrations here are
forward-only and Supabase never re-runs them; and a counter that treated the SUMMARY row as a
check, double-counting every failure and reporting a clean run as failing.

## 0030 — 2026-09-13 — Wilder's recursion exists once; a week is complete when it is not the newest

**Decision:** the weekly layer ships as `weekly_bars` (a view) and `weekly_features` (a matview),
and getting there required extracting Wilder's smoothing and the EMA seeding into a single
timeframe-agnostic function, `public.recursive_indicators(date[], double precision[])`. Both
`daily_recursive` and the weekly matview call it. Neither contains the formula.

**Why not just write the weekly recursion beside the daily one:** because hard constraint 7 says a
plain rolling mean is a different indicator wearing the same name, and the gap runs to 9.4 RSI
points. Two copies of that logic is the most plausible way this project ever ships a daily number
and a weekly number that disagree about what RSI means — and the disagreement would look like
market behaviour, not a bug. The function takes **arrays**, not a table name, so it cannot quietly
couple itself to one timeframe's storage.

**Rewriting a function the daily layer already depends on is normally reckless.** It was safe here
for one specific reason: decision 0029's CI gate compares `daily_features` against an independent
implementation at 1e-9, so a regression in the refactor fails the build instead of reaching the
dashboard. The gate reported *every daily formula value unchanged* — and that, rather than
confidence, is what made the change defensible. This is the first time a gate built for one purpose
has paid for itself on a different one.

**A week is complete when it is not the most recent week for that symbol.** We have no market
calendar and are not buying one. That definition needs none: only the newest week can still gain
bars, so every earlier week is finished. It is per-symbol, so a name that stopped trading cannot
make another name's partial week look settled, and it handles holidays for free — a
holiday-shortened week is a normal week with fewer bars. `bars_in_week` is published so a reader can
see a short week; `is_complete` is what they filter on (hard constraint 5).
**Rejected:** `bars_in_week = 5`, which is the obvious definition and silently drops every holiday
week, so `scripts/verify_parameters.sql` now carries a check whose only job is to fail the day
someone writes it. Also rejected: a hardcoded US market-holiday table, which would need maintaining
forever to answer a question we do not have to ask.

**The weekly goldens are pinned at the same 1e-3 as the daily ones**, which overturns the plan
recorded against task #45. That plan said to derive a looser tolerance because a weekly series has
~1/5 the bars and a heavier seed residual. Measured on the 5-year backfill: residual seed weight
1.75×10⁻⁸ for RMA(14), 1.87×10⁻¹⁰ for EMA(21), with SQL–Python agreement at 5.0×10⁻⁸ and 9.9×10⁻⁸.
Five orders of margin. The plan was right for the 102 weekly bars we held when it was written; the
backfill invalidated it — the third time in one day a measurement was overturned by more data
rather than by being wrong, which is an argument for re-measuring before trusting a plan, not for
distrusting plans.

**And the part CI caught that nobody would have:** a materialized view is populated once, at
creation. `swing-refresh-features` named `daily_features` explicitly, so without an amendment
`weekly_features` would have been correct on the day it shipped and a day staler every day
afterwards, with no error anywhere — the **sixth** "operation that succeeds and changes nothing" on
this project. The weekly assertions surfaced it as MISSING rather than FAIL, because in CI the
migration runs before the fixture loads; the fix in `scripts/ci/run.sh` and the fix in production are
the same fix, which is the useful part. The refresh job now names both matviews.

## 0031 — 2026-09-15 — Reads retry, sends never; and absence of data is never reported as health

**Decision:** the digest's three PostgREST reads go through `readWithRetry` (three attempts, 200 ms
then 600 ms). If a read still fails it returns `null` rather than throwing, and the email is **sent
anyway** with the gap named at the top. The Resend call is still never retried.

**Why the asymmetry is the whole design.** `digest/index.ts` has said since it was written that it
does not retry, because "retrying an email risks sending two, which is worse than sending none".
That judgment was about the **send** and it stands. A PostgREST GET is idempotent — running it three
times costs milliseconds and can produce nothing worse than the same rows twice. A Resend POST is
not, and a duplicate digest in ten inboxes cannot be recalled. Conflating the two is what left the
reads unprotected for as long as they were.

**This is not a new pattern, it is one the digest missed.** CONSTRAINTS has carried since 2026-09-13
that "every Supabase READ in the ingest retries once after 400 ms; writes are not retried", added
after four flaky reads in one backfill session. The ingest was hardened; the digest, written later,
was not. Worth noticing as a class of bug: **a lesson learned in one component does not propagate to
the next one by itself.**

**Why an incomplete email rather than no email.** Decision 0027 says an email that only arrives on
interesting days cannot be told apart from a broken pipeline. A read failure was producing exactly
that silence. So a partial digest, clearly labelled `INCOMPLETE` in the subject and naming what it
could not read, is strictly better than nothing — and on 2026-09-14 two of the three reads had
succeeded and were thrown away.
**Rejected:** retrying the send (see above); suppressing the email on any read failure (the status
quo, and the bug); retrying only errors that look transient — sorting transient from permanent by
matching on a message string is guesswork that rots the first time a vendor rewords an error, and
the cost is asymmetric, since retrying a permanent failure wastes two GETs while not retrying a
transient one costs the whole email.

**The same principle, applied to the dashboard in the same PR.** `Status` on the web side declared
every field as present (`hours_since_success: number | null`), which is a guarantee two independently
deployed pipelines cannot give. The fields are now optional, so the compiler forces every reader to
separate three cases that were collapsing into one cheerful string: `undefined` (the field was not in
the response — we know nothing), `null` (the view returned SQL NULL — a real fact), and a value. On
2026-09-13 that collapse displayed **"Last ingest: never · ok"** on a perfectly healthy pipeline.

**The one-sentence version of both halves: absence of evidence is not evidence of health.** An unread
change list is not a quiet day, and a missing freshness field is not a fresh pipeline.

## 0032 — 2026-09-15 — Weekly joins to the day by date arithmetic; two columns ship uncoloured

**Decision:** the four weekly parameters appear on the grid. `grid_cells` gains them plus a
`timeframe` column, and the weekly value shown on day *d* is **the newest week that started strictly
before the week containing d**:

```
week_start < date_trunc('week', d)
```

**Why that rule and not the `is_complete` flag.** `is_complete` means "not the newest week in the
data as it stands today". It is a fact about *now*, so a backtest standing on 2024-03-05 that
consulted it would be asking a question only the present can answer. The date comparison needs no
market calendar, no flag, and returns the same answer whenever it runs — which is what keeps
parameters a pure function of (ticker, date), decision 0002. It also cannot leak the future: any week
earlier than d's own week had certainly finished by d, and d's own week is excluded by construction.
That is hard constraint 5 expressed as arithmetic rather than as a warning.
**Rejected:** joining on `is_complete` (above); a separate weekly grid the page reads alongside the
daily one (two queries, two date pickers, and the replay property split across them); storing weekly
values on every daily row in `daily_features` (rebuilds a verified matview to denormalise something
a range join gives for free).

**`close_vs_sma200w` ships uncoloured, and its norm is deleted.** It had `{low: 0, high: 10}` —
"near long-term support = interesting". Measured across every complete week we hold: **87–90% of
name-weeks sit above +10 in every single year, and only ~4% ever land inside the band.** That is
structural, not a market phase. Distance above a four-year mean mostly says how long the universe has
been rising; it is not a statement about the name. A threshold that flags nine rows in ten is
decoration, not judgment, and colouring almost every cell trains the reader to ignore the colour.
`close_vs_sma30w` is likewise uncoloured, for the duller reason that no threshold has been measured.
**Rejected:** widening to 0…150, which would fit this month and be wrong in another regime with no
principle for when to move it; and leaving the column off entirely, which hides a number that is
perfectly informative uncoloured. A cross-sectional percentile would be meaningful in any regime and
is the right long-term answer — it waits for the sector-rank work.

**The digest stays daily.** Weekly values step for the whole watchlist on one Monday, so putting them
in `digest_changes` would add a measured mean of **11.6 crossings every Monday** (p90 18, worst 26) —
against a whole daily digest of ten on 2026-09-14. Those crossings are real but they are the calendar
turning over, not news, and an email that reads as dramatic every Monday by construction is one you
stop believing, which is the failure decision 0027 exists to prevent. One predicate,
`timeframe = 'daily'`, easy to remove when weekly movement gets a treatment of its own.

**Not done, and deliberately: `pct_off_52w_high` was NOT retuned.** It looked mis-set — on
2026-09-15 its −25 floor flagged half the watchlist, with the median sitting at −23.8. Over 17,512
name-days of the last two years it flags **28%**, with a median of −13.5. The 50% was a drawdown, not
a calibration fault, and the norm was reporting it correctly. Recorded here because the change was
approved on the strength of the one-day number and then withdrawn on the two-year one: **a threshold
judged against a single day's snapshot is a threshold tuned to noise.**

## 0033 — 2026-09-15 — The index series get their own morning run, and their lag is a published number

**Decision:** a fourth pg_cron job, `swing-refresh-indices`, calls the ingest with a new
**`indices`** scope at **11:00 UTC every day**. A new view, `public.index_status`, reports how far
each index series lags the equities, in trading days.

**The problem it solves.** FRED publishes later than the 22:30 UTC ingest. On 2026-09-14 that run
returned Monday's bar for all 36 equities and Friday's for `^VIX`, `^VIX3M` and `^GSPC`. A stale
price is visibly stale; **a stale VIX is simply wrong** — "VIX 16, calm" when yesterday it spiked to
28 is the most believable kind of wrong, and market context is the next thing to be built on these
series.

**11:00 UTC, every day.** 07:00 ET: after any overnight publication, hours before the next session,
so the previous close is in place before anyone opens the dashboard during US hours. Every day rather
than weekdays because Friday's close is what a Saturday run collects — a weekday-only schedule would
leave the whole weekend showing Thursday.

**The hour is a starting point and the migration says so.** FRED's real publication time could not be
derived from our data: one clean observation, and every other index row from a single backfill.
`index_status` exists partly so the hour can be tightened after a week of real runs. Choosing a
tighter hour from two data points would be the same error as tuning a norm to one day's snapshot
(decision 0032).
**Rejected:** moving the main 22:30 run later, which would trade a solved problem — the equity bar is
settled year-round across both DST shifts (0022) — for an unsolved one; and doing nothing and
labelling the lag, which is the *fallback*, not the fix, and leaves the number a day old for every
reader rather than for a few hours.

**`indices` is not part of `all`.** `all` already covers the index series through `daily`. Two names
for the same work is how a run happens twice. `universeFor()` in `provider.ts` makes the mapping
explicit and exhaustive, and it lives there rather than in `index.ts` because that file calls
`Deno.serve` at module top level and cannot be imported by a test.

**An index run writes `detail.indices`, never `detail.daily`.** `grid_status` counts a run as a data
success only when `detail ? 'daily'`. Had the new run used that key it would reset the staleness
clock every morning, so a dead equity pipeline would look healthy — the "successful operation that
changed nothing" shape this project has now produced six times. The key choice is the whole guard.

**What this deliberately does not fix.** If FRED has not published day *d*'s value by 22:30 on day
*d*, the grid row built that evening still carries an index value from *d−1*. The morning run closes
it for every later reader, and `index_status` reports it honestly meanwhile. So market context reads
its as-of date from `index_status`, not from the grid. That degradation is the design, not an
oversight.

## 0034 — 2026-09-15 — The market block is a view, every borrowed value carries its own date

**Decision:** `public.market_context`, one row per tracked date: VIX level and fixed regime band,
VIX term structure, S&P 500 close, and watchlist breadth. **A plain view, not a materialized one**,
and every value borrowed from the FRED series is published beside the date it actually came from.

**Why a view, against the habit of this project.** Every other derived layer here is a matview
because it is expensive per row and read per symbol. This is one row per date over ~1,200 dates, and
its inputs refresh on **two different clocks** — equities at 22:30, the index series at 11:00 the
next morning (decision 0033). A matview would be correct only between those two moments and quietly
wrong the rest of the time, or would need adding to both jobs. A view is always current and is one
fewer thing to forget in the migration that adds the next matview.

**As-of, not exact-match, and the date is published.** On the evening the grid is built there is
often no index bar for that date yet. Leaving the block null would blank it every evening and refill
it every morning, which reads as a fault. So each series is taken as of the date — the newest bar on
or before it — and `vix_as_of`, `vix3m_as_of` and `spx_as_of` say which day the number is really
from. `vix_as_of < d` is an honest report of a known lag; **"VIX 15.84" printed under Monday's date
when the number is Friday's is not**, and that is what a silent join would produce.

**Term structure is null unless both series share an as-of date.** This is the subtle one, and the
first version got it wrong. Both series are taken as of independently, so on a date where `^VIX3M`
has no observation the as-of join supplies an older one — and the ratio would then divide today's VIX
by last week's VIX3M and report a clean percentage. **A term structure is a statement about one
moment in the curve; two moments is not a stale reading of it, it is a different quantity wearing its
name.** Production has 33 such days in 2,785. Caught by a CI fixture built to drop `^VIX3M` on a
cycle for exactly this reason.

**Null is not zero, in three places, each measured first.** `term_structure` null on 33 of 2,785 VIX
days (0 would read as a flat curve). `breadth_pct` null on 199 of 1,236 dates where no name yet has
200 bars (0% would read as every name below its 200 SMA — the most bearish value the field can take).
`spx_close` null before FRED's licensed window opens in 2016. `breadth_eligible` is published beside
the percentage because 0% of 2 names and 0% of 36 are different facts.

**Bands stay fixed, not percentile.** A percentile band calls 16 "high" in a calm decade and "low" in
a violent one; a regime label has to mean the same thing every year. Measured over 2,785 days the
fixed bands land at 43% / 51% / 5% / 0.6% / one single day above 80 — well shaped, and the rarest
band is exercised in CI because production would otherwise never test it.

**Relative strength is deliberately NOT in this PR.** It shares nothing with the market block but a
migration slot, and it has its own subtle problem — lagging on each series' own bar index rather than
the calendar. Two separable problems, two reviews.

## 0035 — 2026-09-15 — Relative strength counts bars in each series, and publishes no as-of layer

**Decision:** `public.relative_strength` — RS against the S&P 500 at **63, 126 and 252 trading
bars**, as `(close[t]/close[t−n] − 1) − (spx[t]/spx[t−n] − 1)` in percentage points. `lag(close, n)`
over each series' own partition, joined to SPX on an **exact date**. Rows exist only where both legs
have a bar.

**Bars, not calendar months.** `d − interval '63 days'` spans about 43 trading days and lands on a
weekend or holiday roughly a third of the time, silently taking a neighbouring row or none. Measured
first, because the subtraction rests on it: across the 1,236 dates we hold, SPX is missing **exactly
one**, and that one is 2026-09-14 — the FRED publication lag, not a calendar difference. So "n bars
back" is the same window on both legs.

**No as-of layer, which is a deliberate departure from `market_context` (0034).** The obvious design
carries each symbol's newest RS forward onto grid dates SPX has not reached, publishing `rs_as_of`.
It was written that way and then measured:

| | |
|---|---|
| exact-date join, whole history | **441 ms** (42,353 rows) |
| with a band join for the as-of | **8,826 ms** — the planner discards **51 million** candidate pairs |

Twenty times the cost to handle a single trailing date. The band join is cheap inside `grid_cells`
(20 ms for one date) only because a date predicate cuts the left side to 36 rows first; unfiltered it
degenerates, and "the same query serves today's scan and a ten-year replay" is a stated property of
this project, so the unfiltered case is not hypothetical.

So the view publishes rows **on the dates the computation is valid for** and nothing else. A reader
wanting the newest RS takes the last row, which is an indexed lookup, and the date it carries *is*
the as-of date. Same honesty, different cost.
**Rejected:** the band join (above); forward-filling SPX's close onto missing dates, which would end
the two legs on different sessions — the term-structure defect of 0034 in another costume; and a
matview, which would need refreshing on both the 22:45 and 11:00 clocks and would otherwise hold RS a
full day behind rather than a few hours.

**Visible consequence:** on the evening of a trading day there is no RS row for that date, because
SPX has not published. `index_status` says exactly that, and the 11:00 catch-up fills it. **A blank
is the correct rendering of "not computable yet."**

**No warm-up flag, unlike the recursive indicators.** RS is a ratio of two closes: below n bars
`lag` returns null and the value is null. There is no seed to decay, so nothing is ever computed but
untrustworthy. `rs_252b` stays null for a name's first year — the honest answer, not a gap to fill.

**A naming mismatch left deliberately unresolved.** `config/norms.yml` carries `rs_vs_spx_6m`, from
before this decision. 126 bars is *about* six months and is not six months, and a column named for
one while computing the other is the labelling failure decision 0019 refused for ^SOX. The columns
here are named by bars; **the norm gets renamed when the grid column lands**, not quietly matched to.

## 0036 — 2026-09-16 — The as-of week is resolved once, as an equality, not searched per row

**Context:** the band join of 0032 timed out the digest and very nearly the dashboard (INCIDENTS
2026-09-16). The rule it implements is not in question — hard constraint 5, *the weekly value shown
on day d comes from the newest week that started strictly before the week containing d* — only where
that lookup happens.

**Decision:** resolve it **once per weekly row**, not once per daily row. `weekly_in_force` carries,
for each `(symbol, week)`, the values of the *previous* weekly bar plus `source_week_start` naming
which week they came from. A daily row then joins on `w.week = date_trunc('week', d)`, which is an
equality on `weekly_features_pk`.

**Why this is the same set of rows and not merely a similar one.** The two agree exactly as long as
every week holding a daily bar also holds a weekly row, because then "the row before this week" *is*
"the newest week before this week". That holds by construction — `weekly_bars` groups the same
`daily_bars` that `daily_features` is built from — but "holds by construction" is how silent
corruption gets in a year later, so it is a CI assertion rather than an argument. Confirmed
empirically too: on the fixture, old and new `grid_cells` are identical row for row, 8,744 each,
`except all` empty both ways, and the existing as-of checks (a correlated `max()` re-derivation, the
source week having ended before the day it is shown, constant within its week, nothing before a
symbol's first week) all still pass.

**The first week of a symbol still produces no weekly cells.** That is a `source_week_start is not
null` filter, and it is the one place where getting the equivalence wrong would show up as *extra
rows* rather than as a slow query. A row of nulls would have been wrong: null means "we have the week
and the number is unknown", absent means "there is no such week".

**A second decision, smaller and worth stating separately:** `grid_status` and `digest_standing` no
longer read `grid_cells` to learn the newest date and the symbol count. They read `daily_features`
with the same `active and not is_index` predicate, which is identical by definition — `grid_cells`'
daily branch *is* that join, and its weekly branch is built from the same rows, so it can add neither
a symbol nor a later date. The equi-join alone would have taken the banner from 3.1 s to 528 ms;
this takes it to 23 ms, and stops its cost scaling with the number of **parameters** rather than the
number of symbols. At 200 tickers that is the difference between ~2.5 s and no change.

**Rejected:** an index or a matview over `grid_cells`. Both treat a plan defect as a volume problem,
and a matview would put the grid a refresh behind the data for no reason. Also rejected: patching the
three current call sites, which leaves the next unfiltered read — a backtest, step 10's 200 tickers —
to find the same wall.

**What this costs:** `weekly_asof` is gone, replaced by a view of a different shape under a different
name. `asof` described a lookup; nothing looks anything up now. It was referenced only by
`grid_cells` and two doc lines.

**The standing lesson, recorded because it is about process rather than SQL:** this hazard was
measured at 8,826 ms and written into 0035 the day *after* the band join shipped, by the same hands,
without checking the code that already had it. **Naming a hazard is the moment to grep for it in what
already exists**, not only to avoid it in what comes next.

## 0037 — 2026-09-16 — Vendor fetches retry transport faults and 5xx, never a 4xx, under a wall clock

**Context:** `index.ts` has retried SUPABASE reads since the first backfill. Nothing retried the
VENDOR, so a single transient 502 from Polygon lost that symbol for the night — the per-symbol catch
records it, the loop moves on, and the bar arrives 24 hours later. Recorded as a verified gap in
CONSTRAINTS.md on 2026-09-15.

**Decision:** one policy, in `http.ts`, used by both providers.

| | |
|---|---|
| retried | transport failures — reset, DNS blip, TLS hiccup, per-attempt timeout |
| retried | HTTP 5xx |
| never | **every 4xx**, 429 included |
| never | a 2xx carrying an error body |

**The 4xx line is the whole decision and it is not a detail.** A 401 is a wrong key, a 403 is a plan
that does not cover this, a 404 is a ticker that does not exist; the request will never start being
valid, so a retry buys the same error three times slower. And 429 is the tempting exception that must
stay refused: **retrying a rate limit is exactly what got Supabase's egress IP blocked by Yahoo for
four and a half hours and cost us an entire provider** (decision 0019). 429 means stop, the caller
turns it into a `RateLimitError` and abandons the run deliberately, and nothing in the retry layer may
soften that.

**A 200 with an error body is an answer, not a fault.** Polygon's `status: NOT_AUTHORIZED` and FRED's
`error_message` both arrive as HTTP 200. The retry wraps the fetch, not the parse, so these are never
re-asked — the mapping functions reject them as they always did. Re-asking would mean putting a wrong
question twice.

**The deadline, which is the part that is easy to get wrong.** The edge function has a 150 s wall
clock and a run that hits it loses every per-symbol error it had collected — that is how the first
live attempt became an unexplainable 504. Three attempts at a 20 s timeout is 60 s spent on ONE
symbol: a third of the budget for a thirty-sixth of the work. So an attempt is started only if it can
time out and still be inside a 45 s per-symbol deadline. **A symbol whose attempts all hang gets 2; a
symbol getting fast 502s gets all 3.** That asymmetry is the intent — cheap failures are worth
retrying harder than expensive ones — not a rounding artefact.

**Rejected:** retrying writes, for the reason `retryRead` already gives — an upsert that may have
partially applied must not be blindly repeated. Rejected too: a global retry budget shared across
symbols, which makes one symbol's behaviour depend on the alphabetical position of another.

**Verified by breaking it, twice, because a retry test that only runs against the new code proves
nothing.** With `DEFAULT_ATTEMPTS = 1`, the five new-behaviour tests fail and the three guards pass.
With the policy changed to the tempting wrong one — retry 4xx as well — the guards fail, *including
the 429 test that predates this work*, which is the outcome that matters most.

## 0038 — 2026-09-16 — Two norms retuned on measurement: rsi_weekly widened, the RS norm renamed

**`rsi_weekly` 45/65 → 40/70.** Measured over the whole stored history: at 45/65 it flagged **45.5%
of judged cells**, against 12.0% for its daily sibling. A colour on nearly half of what a column shows
is background, not signal.

The cause was structural rather than a bad number — the band was 20 points wide where the daily one
is 40, and weekly RSI spends most of its life in a trend rather than oscillating around 50. **It was
not the `close_vs_sma200w` failure of 0032**, and the difference is worth keeping straight: that one
was 96% one-sided, a band no name could get inside, and the answer was deletion. This one was 15.5%
below / 30.0% above — genuinely two-sided, genuinely separating, just too narrow. 40/70 targets about
a quarter instead of a half. The last 90 days already read 29% at the old band, so the all-history
figure was inflated by earlier periods and the change is a smaller move than 45.5% suggests.

**`rs_vs_spx_6m` → `rs_vs_spx_126b`.** 0035 named this mismatch and deliberately left it, saying the
norm gets renamed when the grid column lands. It is renamed now instead, one step early: the old key
matched no parameter and judged nothing, the new key judges nothing until the column lands, and doing
it here means the column PR is not carrying an unrelated rename. 126 trading bars is *about* six
months and is not six months; a norm named for one while judging the other is the labelling failure
0019 refused for ^SOX.

**What to watch after the next `scope=all` run:** `norms_without_parameter` in
`verify_parameters.sql` stays at **12** across this change — one key out, one key in. It falls to 11
when RS reaches the grid. A number that RISES means a typo, which is exactly what that check is for.

**Norms reach the grid through the ingest, not through the merge.** The sync runs on `tickers` and
`all` scopes only; the 11:00 index catch-up is `scope=indices` and does not touch norms. So these two
changes take effect at the **22:30 UTC run**, not when the PR merges. The same lag caught out the
`close_vs_sma200w` deletion the day before.

