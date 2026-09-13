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
| Plan and scope | `docs/PROPOSAL.md` |
| Indicator formulas, TradingView-anchored | `docs/DEFINITIONS.md` |
| Why we chose X over Y | `docs/DECISIONS.md` |
| Verified facts about external APIs | `docs/CONSTRAINTS.md` |
| What exists and how it works | `docs/FEATURES.md` |
| What has broken before | `docs/INCIDENTS.md` |
| Shared vocabulary | `docs/GLOSSARY.md` |
| Watchlist — edit this, not code | `config/watchlist.yml` |
| Colour thresholds | `config/norms.yml` |
| Task procedures | `.claude/skills/` |

## Current state

Phase 1 (tracker) in progress. Foundation schema applied (`tickers`, `daily_bars`,
`hourly_bars`, `ingest_runs`); the `ingest` edge function exists and is run by hand, now over
Polygon + FRED (decision 0019), with a full verified daily backfill in place. The **daily**
parameter layer exists as the `daily_features` matview, checked by
`scripts/verify_parameters.sql`, and **pg_cron now runs the whole pipeline** — ingest at 22:30
UTC and a concurrent matview refresh at 22:45, weekdays (decision 0022). There is no user-led
refresh by design, so those two jobs are the only path: if they do not fire, the dashboard is
stale and nobody can fix it from the page. A green `cron.job_run_details` row is **not** evidence
of a good ingest — pg_net is fire-and-forget. Check `ingest_runs`, then the freshness check. `web/` holds a deployment-check page, not the dashboard. The pg_cron schedule,
session-aligned hourly bars, weekly and market-context parameters, cross-sectional ranks, CI
gating of the golden values, and the grid itself do not exist yet.
`docs/FEATURES.md` is the authoritative list. Phase 2 (rule engine, alerts, backtesting) is
specified, not started.
