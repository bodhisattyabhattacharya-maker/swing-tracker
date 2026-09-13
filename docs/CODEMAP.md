# Code map

Where code lives, how data flows, and where to start reading. **Update this whenever you change
the structure or add an entry point** — a stale code map is worse than none, because it sends the
next agent to the wrong file confidently.

> **Status: mostly empty.** Phase 1 is not built. Directories marked _(planned)_ exist as
> placeholders. Everything below marked _(planned)_ is intent, not reality — check
> `docs/FEATURES.md` for what actually exists.

## Data flow

```
                 ┌─ Polygon aggregates ┐       (keyed; unlimited calls, 5y on Starter)
                 │  daily OHLCV        │
                 └────────┬────────────┘
   ┌─ FRED ───────────────┤                    (keyed; VIX, VIX3M, SP500 - closes only)
   ┌─ SEC XBRL ───────────┤                    (keyless, point-in-time)
   │                      │
   │              ┌───────▼──────────────┐
   └──────────────►  Supabase            │  ← ALL fetching happens here.
                  │  edge functions      │    Never from a dev machine: no egress.
                  │  + pg_cron           │
                  └───────┬──────────────┘
                          │ writes raw bars + filings
                  ┌───────▼──────────────┐
                  │  Postgres            │  hourly_bars, daily_bars, weekly_bars,
                  │                      │  fundamentals, ingest_runs
                  └───────┬──────────────┘
                          │ SQL views (no network needed)
                  ┌───────▼──────────────┐
                  │  parameters          │  the 26 tracked numbers
                  │  + norms applied     │  → same query serves today's scan
                  └───────┬──────────────┘    and a 10-year replay
                          │                   daily_features EXISTS (matview, refreshed
                          │                   by hand); weekly, market context and the
                          │                   joined grid are still planned
                 ┌────────┴────────┐
        ┌────────▼──────┐   ┌──────▼─────────┐
        │ Next.js grid  │   │ email digest   │
        │ (desktop)     │   │ (scheduled fn) │
        └───────────────┘   └────────────────┘
```

## Directories

| Path | Holds | Entry point |
|---|---|---|
| `config/` | `watchlist.yml`, `norms.yml` — the two things we tune most, as data | Read by ingest and the grid. **Never hardcode what lives here.** |
| `supabase/migrations/` | Timestamp-named, forward-only SQL. Applied by the Supabase GitHub integration on merge to `main`. Includes the pg_cron schedule — `select jobname, schedule from cron.job` is the live answer to "what runs when". | Oldest first; never edit a merged one |
| `supabase/functions/` | Deno edge functions, one directory each. `ingest/` exists: `index.ts` (handler, routing, run bookkeeping) → `auth.ts` (who may call) → `provider.ts` (the seam: `supports()` routes, `minIntervalMs` paces, `planLimit()` caps one run) → `polygon.ts` (equities) and `fred.ts` (index series), plus `watchlist.ts` (yml → `tickers`). `search/`, `digest/` _(planned)_ | `index.ts` in each; tests are `*_test.ts` beside the code, run by CI |
| `web/` | Next.js 16 App Router, TypeScript, desktop-first. Only `app/page.tsx` exists: a deployment check that reads no data. The grid is _(planned)_ and blocked on parameter views + read policies. | `app/page.tsx`; Vercel root directory is `web/` |
| `scripts/` | SQL you paste into the Supabase editor, not code that runs on a schedule. `verify_parameters.sql` — golden values plus invariants, one row per check, `PASS`/`FAIL`/`MISSING`. | Run it after any change to an indicator, and after any ingest |
| `docs/` | Context files. Start at `ONBOARDING.md` | — |
| `.claude/skills/` | Per-task procedures | Matched to your task |
| `.github/workflows/` | CI: secret scan, config validation, edge-function tests, web build, hygiene gate | `ci.yml` |

## Where to start reading, by question

| Question | Start at |
|---|---|
| How does a price get into the database? | `supabase/functions/ingest/index.ts` header, then the latest row in `ingest_runs` |
| How is this number computed? | `docs/DEFINITIONS.md`, then the SQL view named after it |
| Why is this cell coloured? | `config/norms.yml` |
| Which tickers, and why that peer group? | `config/watchlist.yml` (`theme` vs `tag`) |
| Why is this value blank? | Warm-up floor (`DEFINITIONS.md` §4), or a non-rankable theme |
| Are the numbers right? | `scripts/verify_parameters.sql` — paste it into the SQL editor and read the rows |
| Why is a number there but not coloured? | Its `*_seed_ok` flag is false — computed, but still partly its seed |
| What broke last time? | `docs/INCIDENTS.md` |
| Why is the data stale? | `public.ingest_runs` first, then `cron.job_run_details`. A green cron row only means the request was queued. |

## Invariants that outlive any refactor

1. **Fetching lives in Supabase.** Nothing on a dev machine reaches a data provider.
2. **`config/` is the source of truth** for the watchlist and norms. Code reads it; code never
   duplicates it.
3. **Parameters are a pure function of `(ticker, date)`.** This is what makes replay free. Any
   change that breaks it costs us backtesting.
4. **Weekly reads the last completed week.** Never the current partial one.
5. **Tables are RLS deny-by-default.** The schema is public; assume it is read.
