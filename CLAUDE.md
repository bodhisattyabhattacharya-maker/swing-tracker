# Swing Tracker — read this first

End-of-day dashboard over a fixed watchlist of **53 securities** in 9 themes: a **51-column**
catalogue of which **22 read live data today**, colour-coded against norms we set.
Swing / LEAPS horizon, 6 months+. **A tracker, not an advisor** — no score, no ranking in v1.
Two people, Claude coding on both ends, stateless sessions. This file is the shared memory.

**New to this repo? Read `docs/ONBOARDING.md` first** — a 15-minute read order, a
comprehension check, and the six mistakes new sessions keep making here.

## Hard constraints — verified. Do not rediscover these.

Evidence and dates in `docs/CONSTRAINTS.md`; formulas in `docs/DEFINITIONS.md`.

1. **No market-data egress from this sandbox.** Every provider fails at the proxy, and Yahoo is
   robots-disallowed even for the sanctioned fetch tool. Never write a local fetch script, and
   never route around this. All fetching runs **inside Supabase**; experiments run from the SQL
   editor via `net.http_get` and a human presses the button.
2. **Yahoo is dead to us, permanently.** One 90-request burst got Supabase's egress IP blocked;
   still `429` after 4.5 hours of silence and on a second host. Keyless Yahoo is not an option
   from a shared cloud IP — decision 0019, INCIDENTS.md 2026-09-13.
3. **Prices come from Polygon (now massive.com), indices from FRED.** Both keyed, both with
   published limits. Polygon **Stocks Starter** ($29/mo since 2026-09-13): unlimited calls and
   5 years of history. The binding constraint is now the edge function's 150 s wall clock, not a
   rate limit — and because that cap cuts an ALPHABETICAL TAIL rather than a sample, it must
   exceed the universe. It did not on 2026-09-18 and eleven names were starved nightly while the
   run reported success (decision 0045). "% off all-time high" is bounded by what we store, which
   is why the parameter is named `pct_off_high_stored` for its window.
4. **SEC XBRL works keyless**, stamped with filing dates, so genuinely point-in-time. Needs a
   User-Agent with a contact email.
5. **Weekly features join to the last COMPLETED week.** Never the current partial week — that
   leaks future days into a backtest.
6. **Extremes use intraday highs and lows, never closes** — for equities. FRED index series are
   closes only and have no high to misuse.
7. **RSI uses Wilder smoothing** (alpha = 1/n). A plain rolling average of gains and losses is a
   different indicator that shares the name — the gap runs to tens of RSI points.
8. **Respect warm-up floors.** Below them a recursive indicator still reflects its seed; suppress
   the value rather than showing it.

## House rules — every session

- **Orient first.** Read this file and `docs/DECISIONS.md`, then run `make context`.
- **Don't contradict a logged decision** without flagging the conflict.
- **Stay in scope.** Touch only what the task needs. Mention improvements; don't make them.
- **Checkpoint multi-step work** — done, verified, left. Lost the thread? Stop and restate.
- **Simplest thing that works.** No abstraction nobody asked for.
- **Every change has a paper trail.** What you changed decides what else you must update —
  the matrix is in `docs/HYGIENE.md` and CI enforces the parts it can. One issue per change,
  branch `<issue>-<slug>`, never commit to `main`.
- **The PR body is `.github/pull_request_template.md`, filled in — not prose.** Open that file
  and use it verbatim: What and why, **`Closes #<issue>`**, blast radius, hygiene ticks, evidence,
  secrets. The commit format is in `docs/HYGIENE.md` §"Commit format": `<type>: <subject>` and a
  `Closes #<issue>` line. Both existed from the start and were ignored for eight PRs on
  2026-09-16, which is why those issues had to be closed by hand. A handover that hands over
  well-written prose instead of the template is still wrong.
- **Code is read by strangers.** The next session has no memory of writing it. Comment the
  *why*, never the *what*; every migration and function opens with a purpose header.
  See `docs/CODE_STYLE.md`.
- **Tests encode intent.** One that passes against a hardcoded return value is worthless.

## Hard stops — confirm in-session, every time

Deploying or pushing · applying migrations by any route other than merging a PR · sending
email or any external message · anything irreversible. "You said so earlier" is not confirmation.
Also enforced in `.claude/settings.json`, because prose is not enforcement.

## This repo is PUBLIC

- **Never commit a secret.** `.gitignore` covers `.env*`. Do not work around it.
- The Supabase **anon key is safe to expose** — it ships in the browser bundle by design, behind
  RLS. The **service_role key must never enter this repo**; it lives in GitHub Actions secrets
  and the Supabase dashboard.
- The schema is public, so **RLS correctness is load-bearing**. Tables are deny-by-default; every
  read policy gets reviewed deliberately.

## Where things are

| Need | File |
|---|---|
| **Start here if you are new** | `docs/ONBOARDING.md` |
| **What every change must update** | `docs/HYGIENE.md` |
| One-time account and service wiring | `docs/SETUP.md` |
| Where code lives, how data flows | `docs/CODEMAP.md` |
| How to write code here | `docs/CODE_STYLE.md` |
| Plan and scope — what the product **is** | `docs/PROPOSAL.md` (**v2**; versioned, not frozen — decision 0024) |
| Indicator formulas, TradingView-anchored | `docs/DEFINITIONS.md` |
| Why we chose X over Y | `docs/DECISIONS.md` |
| Verified facts about external APIs | `docs/CONSTRAINTS.md` |
| What exists and how it works | `docs/FEATURES.md` |
| What has broken before | `docs/INCIDENTS.md` |
| Shared vocabulary | `docs/GLOSSARY.md` |
| Watchlist — edit this, not code | `config/watchlist.yml` |
| Colour thresholds — edit this, not the table | `config/norms.yml` (synced to `norms`; compared in SQL, decision 0023) |
| Task procedures | `.claude/skills/` |

## Current state — 2026-09-20

Phases 1 to 3 are **live and running unattended**: swing-tracker-nu.vercel.app.

*`docs/FEATURES.md` remains the authoritative list. If this section and FEATURES ever disagree,
FEATURES wins — this one is a summary and summaries rot.*

### What is there, in numbers

| | |
|---|---|
| Securities | **53** — 43 companies and 10 ETFs, in **9** themes; plus 3 index series that are never rows |
| Column catalogue | **51** — **22 live**, 29 planned, in **10 category bands** (0053). 28 carry an `applies` rule, so they are *not applicable* on some rows rather than empty |
| Norms | **15**, in `config/norms.yml`, synced to the database and compared there |
| Bars held | **63,579** daily equity bars over 5 years (2021-10-11 →), **8,063** index rows over 11 years — FRED goes back further than the equity plan |
| Matviews | **4**: `daily_features`, `weekly_features`, `daily_signals`, `market_history` |
| Scheduled jobs | **4** pg_cron, UTC |
| Pages | `/` (Dashboard), `/deep-dive`, `/status` |
| On-demand routes | **2**: `/api/cell-history`, `/api/stock-history` |

**Running on its own**, four pg_cron jobs, UTC: ingest 22:30 → refresh 22:45 → digest 23:00 on
weekdays (decisions 0022, 0028), plus an index-only catch-up at 11:00 **every day** because FRED
publishes later than the evening run (0033). The refresh rebuilds **all four** matviews; any new
matview must be added to that job in the migration that creates it — this project has shipped that
omission three times. There is no user-led refresh by design, so the schedule is the only path.

### Built

**Data plane.** The five-year daily backfill over Polygon + FRED (0019); the daily, weekly and
**signal** parameter layers, with Wilder's recursion existing exactly once in
`public.recursive_indicators` (0030); norms, flags and `grid_cells` across both timeframes with
weekly joined by date arithmetic that cannot see the future (0032); `rs_cells` (relative strength
at 63/126/252 **bars**), `signal_cells` (MA stack, both crosses with bars since, both slopes),
`market_context` and its matview `market_history`; pipeline-based staleness (0026) and
per-symbol coverage (`symbols_priced` / `symbols_behind`, 0045).

**Interface.** The **Dashboard** at `/` — 53 names banded by theme, a two-tier sticky header, four
presets, text filter, per-column sort, the eight-state cell model (0043), a cell detail sheet with
five years of history (0048), and the four market-history charts (0046, 0047). The **Deep Dive** at
`/deep-dive` — one 420px analysis column per security, eight sections at identical heights, six of
them live, with a price panel that reads its own bars on scroll and draws candles or a line
depending on how many fit (0049, 0050). The deployment check at `/status`.

**The header is ten bands** in the spec's order (0053): Price, Technicals · daily, Technicals · weekly, MA signals, Relative, Revenue, Profit, Valuation, Quality, Forward look — measurements split by timeframe, derived signals on their own, which is also a clean split by render kind. Theme bands name their count and bellwether; market tiles carry a descriptor line; warm-up is a hatch rather than ochre text.

**The skin** is the visual specification's: warm cream paper and near-black warm ink, deep
warm charcoal in dark, serif titles, condensed-sans labels, monospace tabular numbers, a floating
bottom-centre tab pill, a coloured rail per category band, and a three-position theme control
(system / light / dark) whose choice is applied before first paint. **Verdicts are muted red and
green** since 0052, which reversed 0018 — the meaning is unchanged, it is still the relationship to
a norm and never a recommendation. Two things deliberately sit outside that pair: the three
moving-average overlays have their own brass/slate/plum tokens, and **VIX is on an intensity scale**
(slate calm, amber stressed) because its band is 16–30 and the verdict mapping would paint a
stressed tape green. Server-rendered with
service_role over PostgREST so the browser never touches Postgres and RLS needs no read policy
(0025); two allowlist routes are the only on-demand reads.

**Guardrails.** The CI formula gate comparing SQL to an independent implementation at 1e-9 (0029);
`check_web_boundary.sh` (5 rules, including that a route holding the key must validate its input);
`check_cell_states.sh` (every grid cell state reachable AND styled); `check_strip_sections.sh`
(the same for the Deep Dive, failing **both** ways — a state with no rule, and a rule for a state
that cannot occur); `check_contrast.sh` (0052) resolves the palette as a browser would and measures
every foreground/background pairing in **both** themes against a 4.5:1 floor, asserts the two dark
token blocks are identical, that every `var()` resolves, that every group has a rail and every tile
scale has rules — and none exists for a scale no tile declares — and that the charts' fallback
palette has not drifted from the stylesheet; `check_render_kinds.sh` (0053) requires every render
kind to have an explicit branch in **both** the grid and the strip — a kind with no branch draws as
a plausible number in silence — requires the two renderers to handle the same set, and prints which
kinds are reachable, since a kind whose every column is `planned` cannot appear however well it is
written.

### Not built

- **Fundamentals** — **22 columns** are fundamentals-sourced: **20 of the 26** in the Value preset,
  plus the **two sector ranks** (valuation, margin), which sit in the Relative group and not in
  that preset. Counted, 2026-09-19; "27 Value columns" appeared in several PR bodies and was
  wrong. All 22 are blocked on the **Massive Financials & Ratios add-on ($29/month)** and its four
  acceptance probes; nothing starts until Bodhi subscribes.
- **Forward Look** — the other **6** of the Value preset's 26. No vendor tier sells analyst
  consensus, so these arrive as **searched** values carrying their own source and as-of date.
  Permanent, not queued.
- **Session-aligned hourly bars**, and the hourly RSI gauge that waits on them. 13,936 exploratory
  hourly rows exist for 4 symbols from a 2024 experiment; nothing reads them and they are not
  session-aligned. Do not mistake them for the feature.
- **Scale-out to ~200 tickers.** Rebuild the ingest around grouped-daily flat files *before*
  adding names: at 200 the per-symbol loop is what breaks, on any vendor.
- **Phase 2** (rule engine, alerts, backtesting) is specified, not started.

### Three things that will bite you, all learned the hard way

- A green `cron.job_run_details` row is **not** evidence of anything but a queued request — pg_net
  is fire-and-forget. On 2026-09-14 it read `succeeded` for a digest that sent no email. Authority
  order: `ingest_runs` → `grid_status` → `cron.job_run_details` last.
- **Absence of evidence is not evidence of health** (0031). An unread change list is not a quiet
  day; a missing freshness field is not a fresh pipeline; a check file that failed to parse is not
  a passing gate; a cell state with no CSS rule is not a styled state. All four shipped as cheerful
  green before they were caught.
- **An as-of value carries its own date.** The index series legitimately lag the grid by a session,
  so `market_context` publishes `vix_as_of` beside `vix` — and a ratio across two different as-of
  dates (term structure) is null, not stale (0034).

### And one that is newer

**A state you cannot reach is a state you cannot trust.** Three times now something has been
declared, styled and documented while being impossible to produce: the `na` cell state (ordering,
0043), a CSS rule for a class that no element carried, and the price chart's line mark, which the
arithmetic allowed and the interface could not reach because panning widens nothing (0050). The
answer each time was a **generic** check that enumerates what can actually happen rather than one
more specific assertion — and, since 0050, one that walks the controls a reader has.

Vercel needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` — the key **must not** carry a
`NEXT_PUBLIC_` prefix, which Next would inline into the browser bundle.
