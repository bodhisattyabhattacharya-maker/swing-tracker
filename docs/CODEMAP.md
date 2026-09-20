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
                  │  parameters          │  22 live of a 51-column catalogue
                  │  + norms applied     │  → same query serves today's scan
                  └───────┬──────────────┘    and a 10-year replay
                          │                   FOUR matviews, all rebuilt at 22:45 UTC:
                          │                   daily_features, weekly_features,
                          │                   daily_signals, market_history.
                          │                   A new one must be added to that job in
                          │                   the migration that creates it - omitted
                          │                   three times so far. Fundamentals planned.
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
| `web/` | Next.js 16 App Router, TypeScript, desktop-first. `app/page.tsx` is **the dashboard** — a server component that reads the four cell views and hands plain rows to `components/ParameterGrid.tsx`, which is `"use client"` and runs the presets, filter, sort, theme bands and cell sheet. `app/deep-dive/page.tsx` is **the strip** — a server component over the same `fetchGrid` read, handing rows to `components/StockStrip.tsx`, which is `"use client"` and renders one 420px analysis column per security with eight sections at identical heights (decision 0049). `app/status/page.tsx` is the deployment check, kept because it answers "is this deployment wired up" without needing the database. **`lib/` is split by what may reach the browser:** `lib/grid.ts` is the only file that talks to Postgres — server only, service_role over PostgREST — while `lib/columns.ts` (the 51-column catalogue, the presets, the cell-state model) and `lib/market.ts` (the four tiles) are **pure** and are what client components import. `scripts/ci/check_web_boundary.sh` fails the build if that split is broken.  `lib/chart-theme.ts` reads the resolved palette off the document so canvas charts follow the page's light/dark tokens instead of carrying their own — including `--ma1/--ma2/--ma3` for the moving-average overlays and `--calm`/`--stress` for the VIX regime strip, both kept off the verdict pair on purpose (decision 0052); `components/ThemeToggle.tsx` is the three-position colour-theme control, a click handler and nothing else: the mode lives on the root element as `data-theme` and `data-mode`, written before first paint by a script in `app/layout.tsx`, and the button's own label is CSS keyed on that attribute so there is no hydration mismatch; `lib/selection.ts` answers which Deep Dive columns are shown and in what order — URL parsing, the bellwether default, and the pick/drop/pin verbs — and deliberately has **no runtime imports**, so `check_selection.sh` can load the real module rather than a transpiled copy; `lib/market-history.ts` is the chart catalogue plus the VIX regime scale — `REGIME_BANDS` with explicit edge ownership, and `bandRects`, which takes a mapping function rather than a chart so the band geometry is testable without a browser — `lib/deep-dive.ts` the strip catalogue, `lib/sparkline.ts` the eight-quarter trace's geometry — shared by the grid cell and the strip row, because a copy in each is how the two ended up disagreeing about colour in September — and `lib/stock-history.ts` the price panel's contract (timeframes, ranges, and the pixels-per-bar rule that decides candles or a line), all pure like `columns.ts` — `deep-dive.ts` resolves its sections against `COLUMNS` and throws at module load on an unknown param, a missing or stale blocked-sentence, or one over 120 characters; `components/MarketHistory.tsx` is the collapsible four-chart panel and `components/StockChart.tsx` the Deep Dive price panel, both `"use client"` and drawn with Lightweight Charts (decisions 0046, 0050); `components/Sparkline.tsx` is inline SVG rather than a chart library call — eight rects in a 54×16 box, potentially 53 on screen at once, where a canvas stack each would be absurd. Two route handlers hold the credential on demand — `app/api/cell-history` and `app/api/stock-history` — and both validate against an allowlist in their pure lib module before touching PostgREST. | `app/page.tsx`; Vercel root directory is `web/` |
| `scripts/` | SQL you paste into the Supabase editor, plus the CI gate. `verify_parameters.sql` — goldens and invariants, one row per check, daily and weekly. `ci/` — `run.sh` applies every migration to an empty database, loads a synthetic fixture and compares against an independent reference; runnable by hand against any empty PostgreSQL, which is how every migration here gets verified before its PR. `ci/check_web_boundary.sh` guards the client/server split and the CSS template literal; `ci/check_cell_states.sh` asserts every declared cell state is reachable and styled in the grid; `ci/check_strip_sections.sh` does the same for the Deep Dive strip, whose rules are different selectors on different elements, and fails **both ways** — a state with no rule that colours it, and a rule for a state the strip cannot produce; `ci/check_render_kinds.sh` asserts every way a value can be drawn is drawn the same way in both places that draw it, and prints which kinds are reachable at all; `ci/check_regime_scale.sh` asserts the VIX bands tile the number line, that exactly one band owns each edge, and that every band has somewhere to be drawn in both themes; `ci/check_selection.sh` asserts no URL — malformed, stale, repeated or enormous — can empty the strip, that picked order survives, and that the round trip through the query string is lossless; `ci/check_contrast.sh` resolves the design tokens the way a browser would and measures every foreground/background pairing in both themes against a 4.5:1 floor, plus the completeness checks a palette needs and nothing else performs — the two dark blocks identical, every `var()` defined, every group with a rail, every tile scale with rules and no rule without a scale, and the charts' fallback palette matching the stylesheet value for value — all seven run in the `web` job, not against a database. | `scripts/ci/run.sh`; run `verify_parameters.sql` after any indicator change or ingest |
| `docs/` | Context files. Start at `ONBOARDING.md` | — |
| `.claude/skills/` | Per-task procedures | Matched to your task |
| `.github/workflows/` | CI: secret scan, config validation, edge-function tests, web build, hygiene gate | `ci.yml` |

## Where to start reading, by question

| Question | Start at |
|---|---|
| How does a price get into the database? | `supabase/functions/ingest/index.ts` header, then the latest row in `ingest_runs` |
| How is this number computed? | `docs/DEFINITIONS.md`, then the SQL view named after it |
| How will a fundamental be computed, before any of it exists? | `docs/DEFINITIONS.md` §7 — settled 2026-09-16, decision 0040, and binding on the implementation. ROIC is the exception and says so: its tax-rate clamp is not measured yet, so it is not implementable. |
| Why is analyst target gap not with the other fundamentals? | Because no source in our data plane has it, and it is an opinion rather than a measurement. It is a **searched column**, deferred to a later version. |
| Why is this cell coloured? | `config/norms.yml` |
| Which tickers, and why that peer group? | `config/watchlist.yml` (`theme` vs `tag`) |
| Why is this row's P/E blank? | It may be an **ETF** — `tickers.is_fund`. A fund has no income statement, so a fundamental is not-applicable, not missing (decision 0041). Not the same flag as `is_index`, which keeps a series off the grid entirely. |
| Why is this value blank? | Warm-up floor (`DEFINITIONS.md` §4), or a non-rankable theme |
| Where is RSI actually computed? | `public.recursive_indicators` — **once**, for every timeframe. `daily_recursive` and `weekly_features` are both callers. Do not add a second copy. |
| What do the moving averages say about each other? | `public.daily_signals` — stack, both crosses with bars since, both slopes. A matview: a date filter cannot pass through a window function, so a view would re-scan every history per page load (decision 0042). |
| Why is a chip coloured, when it has no norm? | `signal_cells.tone`, derived from the label rather than from a threshold. A tone is not a verdict, and nothing in `config/norms.yml` can reach it. |
| Is this week finished? | `weekly_features.is_complete`, which means "not the newest week for this symbol". There is no market calendar and none is needed. |
| Which week is a given day showing? | The newest week that started before that day's own week — `weekly_in_force` (`source_week_start` names it), and `DEFINITIONS.md` §"How a weekly value attaches to a day". **Not** `is_complete`, which is a fact about today rather than about that day. |
| Why did a weekly cell not move all week? | Because a weekly bar has one value. It steps on the week boundary and nowhere else. |
| Are the numbers right? | `scripts/verify_parameters.sql` — paste it into the SQL editor and read the rows |
| Why does a panel say it is not built rather than showing nothing? | `web/lib/deep-dive.ts` — a section's state is derived from its params' own `status` and `applies`, so Phase 4 flips the Fundamentals panel in the same commit that flips the columns. Three invariants run at module load, including a 120-character cap on the sentence, because it renders once per column. |
| Candles or a line? | `web/lib/stock-history.ts` `markFor` — pixels per bar, not a bar count. Candles while each gets 5px; at a 390px plot that is 78 bars. |
| Why does my new column render as a plain number? | It has a render kind with no branch in `Cell` (grid) or the strip's payload, and `number` is the fall-through. `scripts/ci/check_render_kinds.sh` fails on exactly that, in both renderers, and on the two disagreeing. |
| Is a colour legible, and does it exist in both themes? | `scripts/ci/check_contrast.sh`. It is also the only thing that checks the two dark token blocks agree — they are a hand-maintained duplicate, one for the OS preference and one for the toggle, and a drift between them means the same choice produces two different pages. |
| Which of my states can the page actually reach? | `scripts/ci/check_cell_states.sh` for the grid and `scripts/ci/check_strip_sections.sh` for the Deep Dive. The second fails **both** ways: a reachable state with no rule that colours it, and a rule for a state that cannot occur. |
| Can we even compute a fundamental for all 43 companies? | `scripts/probe_sec_tags.sql` — paste it into the SQL editor, one STEP at a time. Asks SEC which tags each filer actually reports, rather than assuming. Not run by CI: it makes outbound requests. |
| Why is a number there but not coloured? | Its `*_seed_ok` flag is false — computed, but still partly its seed |
| What broke last time? | `docs/INCIDENTS.md` |
| Why is a read slow rather than wrong? | `docs/INCIDENTS.md` 2026-09-16 first. A join with no equality in it costs nothing on one date and is quadratic over the whole view; `scripts/ci/check_formulas.sql` section `shape` asserts the plan, because no value check can see this. |
| Why is the data stale? | `public.ingest_runs` first, then `cron.job_run_details`. A green cron row only means the request was queued. |
| Is this name beating the index? | `public.relative_strength` — 63/126/252 **trading bars**, percentage points. No row for the newest trading day until FRED publishes SPX; that blank is correct, and `index_status` says why. |
| Why is a cell coloured, and where is that decided? | In SQL, in `grid_cells`, `rs_cells` or `market_cells` — never in the page. All three spell out the same CASE and `scripts/ci/check_formulas.sql` asserts the three against one reference. |
| Why does the RS column say "as of" a different date? | Because it is. RS exists only on dates SPX also has a bar, and FRED publishes after the equities — so most evenings it is one session behind, and the heading says which. The 11:00 catch-up closes it. |
| What is in the market strip, and as of when? | `public.market_cells` — VIX, term structure, SPX, breadth, each with its OWN as_of, because the FRED series do not all publish on the same day. |
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
