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
