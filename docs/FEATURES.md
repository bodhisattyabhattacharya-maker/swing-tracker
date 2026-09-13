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
