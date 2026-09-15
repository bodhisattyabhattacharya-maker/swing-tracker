# Swing Tracker — read this first

End-of-day dashboard: 26 parameters across ~40 tickers, colour-coded against norms we set.
Swing / LEAPS horizon, 6 months+. **A tracker, not an advisor** — no score, no ranking in v1.
Two people, Claude coding on both ends, stateless sessions. This file is the shared memory.

**New to this repo? Read `docs/ONBOARDING.md` first** — a 15-minute read order, a
comprehension check, and the five mistakes new sessions keep making here.

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
   rate limit. "% off all-time high" is still bounded by stored history, so a backfill runs
   in batches and "% off all-time high" is bounded by what we store.
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

## Current state

Phase 1 (tracker) is **live and running unattended**: swing-tracker-nu.vercel.app.

*This paragraph had drifted into contradicting itself — it announced the pg_cron schedule and then
listed it as not existing. Rewritten 2026-09-15. `docs/FEATURES.md` remains the authoritative list;
if this and FEATURES ever disagree again, FEATURES wins.*

**Running on its own**, four pg_cron jobs, UTC: ingest 22:30 → refresh 22:45 → digest 23:00 on
weekdays (decisions 0022, 0028), plus an index-only catch-up at 11:00 **every day** because FRED
publishes later than the evening run (0033). The refresh rebuilds **both** matviews; any new matview
must be added to that job in the migration that creates it. There is no user-led refresh by design,
so the schedule is the only path — if it does not fire, the dashboard is stale and nobody can fix it
from the page.

**Built:** the full 5-year daily backfill over Polygon + FRED (decision 0019); the **daily** and
**weekly** parameter layers, with Wilder's recursion existing exactly once in
`public.recursive_indicators` (0030); norms, flags and `grid_cells`, now carrying **both timeframes**
with weekly joined to the day by date arithmetic that cannot see the future (0032); pipeline-based
staleness (0026); **the dashboard** at `/`, server-rendered with service_role over PostgREST so the
browser never touches Postgres and RLS needs no read policy (0025), with the deployment check at
`/status`; the **weekday email digest**, which retries its reads and sends a partial email rather
than going silent (0027, 0028, 0031); an **index catch-up run** and `index_status` (0033); the
**market block** `market_context` (0034); and a **CI formula gate** comparing the SQL to an
independent implementation at 1e-9 (0029) — which since 2026-09-15 also fails when a check file does
not run, rather than counting zero failures and reporting green.

**Not built:** relative strength, session-aligned hourly bars, sector-relative ranks, fundamentals
from SEC XBRL, and the scale-out to ~200 tickers. The market block exists in the database but is not
yet rendered on the page. Phase 2 (rule engine, alerts, backtesting) is specified, not started.

**Three things that will bite you, all learned the hard way:**
- A green `cron.job_run_details` row is **not** evidence of anything but a queued request — pg_net is
  fire-and-forget. On 2026-09-14 it read `succeeded` for a digest that sent no email. Authority
  order: `ingest_runs` → `grid_status` → `cron.job_run_details` last.
- **Absence of evidence is not evidence of health** (decision 0031). An unread change list is not a
  quiet day; a missing freshness field is not a fresh pipeline; a check file that failed to parse is
  not a passing gate. All three shipped as cheerful green text before they were caught.
- **An as-of value carries its own date.** The index series legitimately lag the grid by a session,
  so `market_context` publishes `vix_as_of` beside `vix` — and a ratio across two different as-of
  dates (term structure) is null, not stale (0034).

Vercel needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` — the key **must not** carry a
`NEXT_PUBLIC_` prefix, which Next would inline into the browser bundle.
