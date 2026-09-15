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
                          │                   daily_features and weekly_features EXIST
                          │                   (matviews, both refreshed at 22:45 UTC);
                          │                   market context and fundamentals still planned
                 ┌────────┴────────┐
        ┌────────▼──────┐   ┌──────▼─────────┐
        │ Next.js grid  │   │ email digest   │
        │ (desktop)     │   │ (scheduled fn) │
        └───────────────┘   └────────────────┘
```

## Directories

| Path | Holds | Entry point |
|---|---|---|
| `config/` | `watchlist.yml`, `norms.yml` — the two things we tune most, as data. **Removing a key from `norms.yml` deletes the norm**, which is deliberate: a threshold deleted in git must stop colouring cells. A parameter with no norm still shows its value, uncoloured — that is a normal state, not a gap. | Read by ingest and the grid. **Never hardcode what lives here.** |
| `supabase/migrations/` | Timestamp-named, forward-only SQL. Applied by the Supabase GitHub integration on merge to `main`. Includes the pg_cron schedule — `select jobname, schedule from cron.job` is the live answer to "what runs when". | Oldest first; never edit a merged one |
| `supabase/functions/` | Deno edge functions, one directory each. `_shared/` holds code used by more than one (`auth.ts`); an underscore prefix means Supabase does not deploy it as a function. `digest/` renders and sends the weekday email — `render.ts` is the pure wording and `retry.ts` the read-retry loop, both separate so tests can import them without `index.ts`'s top-level `Deno.serve` starting a listener. **Reads retry, the send never does** (decision 0031). `ingest/` exists: `index.ts` (handler, routing, run bookkeeping) → `auth.ts` (who may call) → `provider.ts` (the seam: `supports()` routes, `minIntervalMs` paces, `planLimit()` caps one run) → `polygon.ts` (equities) and `fred.ts` (index series), plus `watchlist.ts` (yml → `tickers`) and `norms.ts` (yml → `norms`/`flags`). `search/`, `digest/` _(planned)_ | `index.ts` in each; tests are `*_test.ts` beside the code, run by CI |
| `web/` | Next.js 16 App Router, TypeScript, desktop-first. `app/page.tsx` is **the dashboard**; `app/status/page.tsx` is the deployment check, kept because it answers "is this deployment wired up" without needing the database. `lib/grid.ts` is the only file that talks to Postgres — **server only**, service_role over PostgREST, and nothing may import it into a client component. | `app/page.tsx`; Vercel root directory is `web/` |
| `scripts/` | SQL you paste into the Supabase editor, plus the CI gate. `verify_parameters.sql` — goldens and invariants, one row per check, daily and weekly. `ci/` — `run.sh` applies every migration to an empty database, loads a synthetic fixture and compares against an independent reference; runnable by hand against any empty PostgreSQL, which is how every migration here gets verified before its PR. | `scripts/ci/run.sh`; run `verify_parameters.sql` after any indicator change or ingest |
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
| Where is RSI actually computed? | `public.recursive_indicators` — **once**, for every timeframe. `daily_recursive` and `weekly_features` are both callers. Do not add a second copy. |
| Is this week finished? | `weekly_features.is_complete`, which means "not the newest week for this symbol". There is no market calendar and none is needed. |
| Which week is a given day showing? | The newest week that started before that day's own week — `weekly_asof`, and `DEFINITIONS.md` §"How a weekly value attaches to a day". **Not** `is_complete`, which is a fact about today rather than about that day. |
| Why did a weekly cell not move all week? | Because a weekly bar has one value. It steps on the week boundary and nowhere else. |
| Are the numbers right? | `scripts/verify_parameters.sql` — paste it into the SQL editor and read the rows |
| Why is a number there but not coloured? | Its `*_seed_ok` flag is false — computed, but still partly its seed |
| What broke last time? | `docs/INCIDENTS.md` |
| Why is the data stale? | `public.ingest_runs` first, then `cron.job_run_details`. A green cron row only means the request was queued. |
| Is this name beating the index? | `public.relative_strength` — 63/126/252 **trading bars**, percentage points. No row for the newest trading day until FRED publishes SPX; that blank is correct, and `index_status` says why. |
| What is the market doing? | `select * from public.market_context order by d desc limit 1` — VIX, band, term structure, SPX, breadth. Read `vix_as_of` before believing `vix`: they differ by design for a few hours each evening. |
| Is the VIX current? | `select * from public.index_status`. FRED publishes later than the evening run, so the index series can legitimately sit a trading day behind the grid; `current = false` for a few hours after the close is normal, past the 11:00 UTC catch-up it is not. |
| Did the digest actually send? | `select * from public.ingest_runs where scope = 'digest'` — `ok` means mail went out, `message_id` is Resend's receipt, `unavailable` lists anything the email was missing. On 2026-09-14 `cron.job_run_details` said `succeeded` for a run that sent nothing. |

## Invariants that outlive any refactor

1. **Fetching lives in Supabase.** Nothing on a dev machine reaches a data provider.
2. **`config/` is the source of truth** for the watchlist and norms. Code reads it; code never
   duplicates it.
3. **Parameters are a pure function of `(ticker, date)`.** This is what makes replay free. Any
   change that breaks it costs us backtesting.
4. **Weekly reads the last completed week.** Never the current partial one — filter
   `weekly_features.is_complete`, which is true for every week except the newest one per symbol.
   A holiday-shortened week is complete; `bars_in_week = 5` is the tempting wrong test.
5. **Tables are RLS deny-by-default.** The schema is public; assume it is read.
6. **Wilder's recursion exists exactly once**, in `public.recursive_indicators`. A second copy is
   how a daily number and a weekly number come to disagree about what RSI means.
