# Swing Tracker — v1 Build Proposal

An end-of-day dashboard that watches a fixed list of companies we already have a thesis on, and tells us when one of them reaches a moment worth acting on.

| | |
|---|---|
| **Horizon** | Swing / LEAPS, 6 months+ |
| **Team** | Two, Claude coding on each end |
| **Repo** | Shared GitHub |
| **Scope** | 26 parameters × 40 tickers |
| **Drafted** | 17 August 2026 |

---

## 1. What this is

**A watchlist of companies we already believe in, with the same parameters tracked on every one of them on a fixed schedule, so we can see which ones are sitting somewhere unusual — cheap enough to buy, or stretched enough to trim.**

Not a screener. A screener searches thousands of names for something interesting; we already know our names. The job is narrower: depth on forty companies instead of breadth across five thousand.

**It has to work in both directions.** The same volatility regime that says when fear is worth buying says when complacency is worth selling into — VIX at 30 and VIX at 15 are both signals, pointing opposite ways. A tool that only ever says "buy" will happily watch us ride a position back down.

Three kinds of miss motivate it:

- **A rally we were never in.** Needs a signal that keeps nagging, not a one-time alert.
- **A specific level reached on a name we were watching.** Needs a threshold trigger.
- **A position we held through the top.** Needs the same machinery pointed the other way — extended against its own history, volatility priced for perfection, nothing left to pay us for the risk.

Most tools only do the second, which is why the first and third keep happening.

v1 is deliberately a **tracker, not an advisor**. Twenty-six numbers per company, every morning, with no gaps. What we conclude from them stays with us.

---

## 2. Features at launch

Everything in v1 serves one goal: a page in front of us each morning that we actually open. Anything else is in section 3.

- **Scheduled data pipeline** — four clocks (hourly, daily, weekly, on-filing), each refreshing the parameters that move at that speed. Runs unattended; failures are logged and visible.
- **Full OHLC, not just closes** — anything computed from range (RSI, true range, intraday extremes) is wrong without it.
- **Three RSI timeframes** — weekly frames the trade, daily times it, hourly says whether today is a bad moment to click.
- **True all-time high and low** — from full listing history, so a name that peaked decades ago is measured against its real high.
- **Searched columns** — forward P/E, PEG, price targets and consensus aren't available from any free feed, and we're not paying for one. A Claude web search fills them weekly, stamped with source, date and fiscal year.
- **A properly deployed app** — a real front end reading live from the database, on a stable URL. Desktop-first: the grid is a wide table and we're not pretending otherwise.
- **A daily digest by email** — the phone surface. Three lines on which names crossed a norm today, with a link. When none did, it says so.
- **Refresh now** — a manual trigger, coalesced and rate-limited so it can't be abused or run up cost.
- **Two roles, enforced in the database** — owners trigger refreshes and searches; everyone else reads. Row-level security, not hidden buttons.
- **Colour-coded against norms we set** — thresholds we define per parameter decide what gets shaded. Editable config, not hardcoded. No score, no ranking.
- **Add a ticker without a UI** — the watchlist is a file in the repo. Add a line, commit, next run backfills its history.
- **Two-person workflow** — one repo holding schema, rules, ingest and frontend. We each run Claude against it and review each other's PRs.

---

## 3. Later, not now

Out of v1 deliberately. Each is worth building once the daily habit sticks.

| | |
|---|---|
| **Company dossiers** | A living page per ticker with a fundamentals rating and upgrade triggers written as *testable conditions*, so the system can tell us when a name meets its own upgrade bar. |
| **News aggregation** | Daily headline sweep per ticker feeding the dossier, plus tracking of names being publicly promoted by market-moving figures. |
| **Portfolio & hedges** | Import positions from broker screenshots, then show theme concentration, expiry ladder and hedge candidates. |
| **LEAPS mechanics** | IV rank, delta, spread liquidity, time-decay profile — the layer that turns a stock signal into a trade. |
| **An opinionated view** | Weighting parameters into a single score and ranking on it. A ranking implies an edge we haven't proven; better to look at the numbers for a few weeks first. |
| **Installable app (PWA)** | Only worth it if the phone becomes a scanning surface. It isn't in v1. |
| **Paid data feeds** | Not needed now, but the ingest layer is built so they drop in without a rewrite — see below. |
| **Personal watchlists** | Separate lists and ratings per person, sharing one data backend. |

The rule engine, alerts and backtesting aren't "someday" — they're **Phase 2**, section 9.

---

## 4. How we build it

**One constraint shapes the whole design:** AI coding sandboxes have no network route to market-data providers — Yahoo, Stooq, Polygon and the rest all fail at the proxy. So the fetching can't live where we write code. It lives in the database platform, which does have open internet access.

```
  1. FETCH            2. STORE           3. COMPUTE          4. PUBLISH
  Database-side  →    Postgres      →    SQL parameters  →   Static page
  functions, on       Hourly/daily/      Same query serves   One URL,
  four clocks         weekly bars,       tonight's scan      desktop-first,
                      fundamentals       and a 10y replay    email digest
```

### The four clocks

| Clock | Runs | Requests/day | What it refreshes |
|---|---|---|---|
| **Hourly bars** | Midday + close | 80 | Two years of hourly bars, refreshed at the tail. Feeds **hourly RSI** only. Twice a day rather than hourly — this is an EOD tool, and hourly RSI only needs to be current when we're about to act. |
| **Daily** | After US close | 40 | Full OHLCV. Recomputes **daily RSI, MA positions, distance from highs, relative strength, realized vol, market and sector context**. |
| **SEC check** | Daily | 40 | Cheap check for new filings. Recomputes **all fundamentals** only when one lands. |
| **Weekly** | Saturday | 80/week | Rolls weekly bars, recomputes **weekly RSI and MAs**, re-pulls **full-history high/low**, runs the **Claude search sweep**. |

**Baseline ≈ 160 requests/day**, plus 80 on Saturdays. Nowhere near any published limit — the SEC's is 10 requests/second, and we run sequentially with a delay.

### Refresh triggers, and why viewer count doesn't matter

The data is **identical for every viewer** — there's no per-user state. So refresh cost must be decoupled from how many people are looking. Ten people pressing "Refresh now" must never cause ten fetches.

The trigger writes to a **job queue, not a fetcher**:

- Requests enqueue against a *scope* (prices, fundamentals, searches) rather than executing directly.
- If a job for that scope completed inside the **15-minute cooldown**, the request returns existing data. Ten simultaneous presses collapse to one job, or zero.
- A **global daily cap** of 12 manual refreshes across all users combined, not per user. Worst case ~640 requests/day, still comfortable.
- Every run is recorded in `ingest_runs` with who triggered it and what came back, so an unexplained spike is traceable to a person.

### Guardrails on the searched columns

These are the only part of the system that **costs money per use and writes to shared state** — a bad value is visible to everyone, not just whoever triggered it. So:

- **Owner-only, enforced in the database.** Row-level security rejects a search trigger from any non-owner. A hidden button isn't a guardrail; the API has to refuse.
- **Capped per day** globally, independent of who asks.
- **Every value stores provenance** — number, source URL, retrieval date, and the fiscal year it refers to. A forward P/E without a stated year is meaningless, and sources use different consensus sets.
- **Usable in a rule as a filter, never as the trigger.** A searched value can narrow a rule as an AND condition — weekly RSI below 35 *and* more than 20% below target — but never fires one alone. It's a slow-moving weekly number: a standing eligibility condition, not something that changes today.
- **Appended, never overwritten.** Every retrieval adds a row. Costs nothing now, and it's the only way we accumulate the history that makes these columns backtestable later.
- **Stale values decay visibly.** A target retrieved five weeks ago shouldn't look like one retrieved yesterday.

### Built so data sources can be swapped, not rebuilt

We're starting keyless and free. If the watchlist grows to hundreds of names, or we want real consensus estimates, we should be able to buy a feed and plug it in — **without touching parameters, rules, norms or the dashboard.** That only holds if the seam is designed in now; retrofitting means rewriting the layer everything else sits on.

- **A provider interface, not provider-shaped code.** Every source implements the same contract — *bars for this symbol over this range*, *this fundamental for this company*. A paid provider becomes a third file, not a refactor.
- **Nothing downstream knows where a number came from.** Parameters compute from tables, and tables don't encode a vendor.
- **Every stored value carries its source.** A `source` column on every row, so a migration is auditable — we can run both providers side by side and compare before cutting over.

What constrains scale isn't the schema, it's the free tier and the unofficial endpoint's patience. Both are what a paid feed fixes, and neither requires the rest of the system to change.

### Surfaces — where this gets used

**Two jobs, not one job at two screen sizes.** Conflating them is what makes most dashboards annoying on a phone.

**The scan** — 26 columns across 36 names, looking for what's out of place — is a wide-table task. That's an information-density problem, not a layout problem, and no responsive trick solves it.

**The nudge** — *"anything I should look at today?"* — is three lines. It doesn't need a table, and it doesn't need to be *visited*. It needs to *arrive*.

| Surface | Job | What it is |
|---|---|---|
| **Desktop web** | The scan | The full grid, uncompromised. Just a URL — opens on any laptop, nothing to install. |
| **Email digest** | The nudge | Daily. Names that crossed a norm, with a link. Read on a phone; if something matters, open the laptop. |
| **Mobile web** | Checking one name | Deliberately thin — a card per ticker, six fields, tap for detail. Useless for scanning, which is the right trade. |

Two consequences:

- **No PWA in v1.** Installable-to-home-screen only pays off if the phone is a scanning surface. It isn't. A bookmark does the same job for nothing.
- **The digest is where "no opinion" gets tested.** Something has to decide what's noteworthy, but it can do that without a view: *"MU's weekly RSI is below 35"* is a fact; *"MU is a buy"* is an opinion. The digest reports norms crossed — same principle as the colour rule, different surface.

Email before Slack: no shared workspace needed, works for anyone we later share with, and it's archivable, so we can look back at what the digest said on a day we didn't act.

### Stack

| Piece | Tool | Why |
|---|---|---|
| Database + scheduler | Supabase | Postgres, edge functions and cron in one free-tier project. Its network reaches the data providers ours can't. |
| Prices, all timeframes | Yahoo chart API | No key, no signup. Hourly, daily and full listing history from one endpoint. Unofficial, so every run is logged. |
| Fundamentals | SEC XBRL | Free, no key, stamped with filing dates — point-in-time, which is what lets us replay a fundamental rule honestly. |
| Searched columns | Claude web search | Weekly, or on demand for one ticker. Writes value, source, date, fiscal year. Owner-only. |
| Front end | Next.js on Vercel | A real deployed app reading live from the database, desktop-first. Free tier, stable URL, deploys on push. |
| Identity & roles | Supabase Auth | **Owner** (triggers refreshes and searches) and **viewer** (read-only), enforced by row-level security so the rules hold even against a direct API call. |
| Daily digest | Resend or Postmark | Sends the morning email from a scheduled function. Free at our volume. The one step outside single-platform tidiness — worth it, because a dashboard you must remember to open is one you stop opening. |
| Code | GitHub | Schema, rules, ingest and frontend in one repo. |

---

## 5. How we work together

The hardest problem isn't the code, it's context. **Claude sessions are stateless, and we'll run several in parallel across two machines.** Without structure, every session re-litigates settled decisions and re-discovers constraints the hard way.

The test for every file below: *does it stop the next session from repeating a mistake an earlier one already paid for?*

### Context files in the repo

The canonical list of context files, with what each is for, is the table in `CLAUDE.md` —
it is the one place that is guaranteed current. What follows is the *design* of that set:

**The three narrative files answer different questions, and the boundary has to be crisp or they rot into the same mush:**

- `DECISIONS.md` — *why we chose this over that.* Written **before** building. Carries rejected alternatives.
- `FEATURES.md` — *what exists and how it works.* Written **after** building. Carries architectural impact.
- `INCIDENTS.md` — *what broke and why.* Written **after** failing.

Read DECISIONS and FEATURES together and you have the full history: every significant choice, and everything built as a result. INCIDENTS is the separate record of where reality disagreed with us.

Dead ends — an approach that burned two attempts and failed — go in `CONSTRAINTS.md`, not a fourth file. A failed approach *is* a discovered fact about the world, which is what that file holds, and it's already what you read before touching ingest.

### Where the ground rules live

Working practices — orient before acting, stay in scope, checkpoint multi-step work, confirm before anything irreversible, simplest solution first — need a home, and the right one depends on **when the rule has to hold**:

| When it must hold | Where it goes | Why there |
|---|---|---|
| **Every turn, every session** | `CLAUDE.md` | Orient before acting, stay in scope, don't contradict a logged decision without flagging it, checkpoint long work. A dozen lines — this file loads every turn, so length is a running cost. |
| **In a specific situation** | `.claude/skills/` | Testing discipline, migration procedure, how to add a rule. Loaded when that task comes up, not carried permanently. |
| **Never, under any circumstances** | `.claude/settings.json` deny list + hooks | Deploying, running migrations, sending email, any irreversible external call. |

That last row matters most. **Prose is not enforcement.** An instruction not to deploy without confirmation is followed most of the time, which is a different thing from always — and "most of the time" isn't a safety property when the action is irreversible. Hard stops get backed by configuration that refuses, not a paragraph that asks.

### Norms that don't rely on memory

Work is tracked as **GitHub Issues** on a project board — next to the code, reachable by any Claude session through the `gh` CLI, and PRs link themselves. Norms live in issue and PR templates rather than in anyone's head, because half our contributors have no head to keep them in.

- **Every change is an issue**, including bug fixes. An issue is where intent lives; the commit only records the result.
- **PRs state their blast radius** — which layer changed: schema, ingest, rules, frontend.
- **Rule changes carry evidence** — any PR touching a rule shows its backtest before and after. Enforced in CI.
- **Sessions end with a log entry.** CI fails a PR that ships a feature without a `FEATURES.md` entry, or fixes a bug without an `INCIDENTS.md` one.
- **New facts about the world get filed** to `CONSTRAINTS.md` with the date verified.

### The harness

Automation that makes the norms mechanical. A norm nobody *can* forget beats a norm everyone agrees with.

| Check | Runs | Catches |
|---|---|---|
| Migration replay | Every PR | Applies migrations to a throwaway database branch. Catches one that only works against the schema already on someone's machine. |
| Rule schema validation | Every PR | Rule JSON validated against a schema; every field it references must exist. A typo in a parameter name otherwise fails silently as "never matches". |
| Backtest delta | PRs touching rules | Runs the changed rule over history, posts before/after edge as a PR comment. Makes "we should always check" unskippable. |
| Ingest smoke test | Every PR + nightly | Fetches one ticker end to end. Unofficial endpoints break without warning; this is how we find out on our schedule. |
| `make context` | Start of a session | Prints live state — last successful ingest, row counts, failing checks, open issues. A fresh session starts grounded in what's true now, not in docs that may have drifted. |
| Constraint staleness | Monthly | Flags `CONSTRAINTS.md` entries older than 90 days for re-verification. |

### Who changed what

Three layers, three questions. **Git** answers what changed mechanically — blame, diffs, a commit trailer naming both the human and the agent. **The narrative files** answer what was built, why, and what broke. **Issues** answer what we intended. None substitutes for the others, and the middle one is what gets skipped and then missed.

**One rule with no exceptions: no keys in the repo.** The database service key and any future provider key live in GitHub Actions secrets and the Supabase dashboard. `CLAUDE.md` states this explicitly, because an agent asked to "make the ingest work locally" will otherwise do the helpful thing.

---

## 6. Parameters — first list

Twenty-six parameters, each with the clock it runs on. A parameter earned a slot only if it can **change a decision**, be **fetched reliably**, and be **replayed over history**.

Valuation is held as a percentile against the stock's own five-year range rather than an absolute number, because an absolute P/E means nothing across a memory maker and a software company.

### Business — the operating company

Nothing here involves the share price. Recomputed when a filing lands.

| # | Parameter | Source | Why it's here |
|---|---|---|---|
| 01 | Revenue growth + acceleration | SEC | YoY, plus this quarter's rate minus last quarter's. The second derivative leads price and almost nobody tracks it. |
| 02 | Diluted EPS growth, YoY | SEC | Earnings actually delivered, not estimated. |
| 03 | Gross & operating margin + trend | SEC | For cyclical semis the direction over four quarters matters far more than the level. |
| 04 | ROIC and FCF margin | SEC | Whether growth creates value, and whether reported profit turns into cash. |
| 05 | Net debt/EBITDA + share count change | SEC | Survival and dilution in one row. Share count is quietly one of the best long-horizon signals. |

### Valuation — price against those fundamentals

| # | Parameter | Clock | Source | Why it's here |
|---|---|---|---|---|
| 06 | Free cash flow yield | On filing | SEC + price | Hardest single number to manipulate. The anchor of the set. |
| 07 | Trailing P/E percentile | On filing | SEC + price | Where today's P/E sits in the stock's own five-year range. |
| 08 | EV/Sales percentile | On filing | SEC + price | Same treatment, and it survives loss-making quarters where P/E breaks. |

### Price behaviour — price against its own history

| # | Parameter | Clock | Source | Why it's here |
|---|---|---|---|---|
| 09 | Daily OHLCV | Daily | Yahoo | The base record. Range-based measures are wrong without it. |
| 10 | RSI (14) — hourly | Hourly | Yahoo | Reported as the standard 3-month hourly RSI. Answers "is right now a bad moment to click", nothing more. |
| 11 | RSI (14) — daily | Daily | derived | The swing-timing frame. |
| 12 | RSI (14) — weekly | Weekly | derived | The frame that matches a six-month hold. |
| 13 | % off all-time high / above all-time low | Weekly | Yahoo | Against the true **intraday** high and low across full listing history, not closes. Decade-old peaks still count. |
| 14 | % off 52-week high | Daily | derived | The drawdown governing recent sentiment. |
| 15 | Daily 50 / 200 SMA position | Daily | derived | Distance and cross state on the frame most people watch. |
| 16 | Weekly 21 EMA / 30W / 200W position | Weekly | derived | Long-term structure. The 200-week is where mature names historically find a floor. |
| 17 | Realized volatility + volume ratio | Daily | derived | Vol for sizing, volume vs its 50-day average for conviction. |

### Relative — this name against other securities

| # | Parameter | Clock | Source | Why it's here |
|---|---|---|---|---|
| 18 | Relative strength vs SPX | Daily | derived | 3/6/12 months against the broad market. |
| 19 | Relative strength vs SOX | Daily | derived | Split from SPX deliberately — a semi can beat the market and still lag its sector, and only the second says whether it's a leader. |
| 20 | Sector-relative valuation rank | On filing | derived | Where its FCF yield ranks inside its theme group. Answers "is this cheap, or is the whole group cheap?" |
| 21 | Sector-relative margin rank | On filing | derived | Same for gross margin. Separates a company executing well from one riding a good cycle. |

### Market — the environment

| # | Parameter | Clock | Source | Why it's here |
|---|---|---|---|---|
| 22 | VIX level and regime band | Daily | Yahoo | Which volatility band we're in changes what any single-name signal is worth. |
| 23 | VIX term structure (VIX vs VIX3M) | Daily | Yahoo | Contango or backwardation — whether the market prices current stress as a blip or a regime. Confirmed free and live. |
| 24 | Watchlist breadth | Daily | derived | Share of our own 36 names above their 200-day SMA. Free from data we already hold, and a better read on our universe than any index. |

### Searched — valuation context, usable as a filter

| # | Parameter | Clock | Source | Why it's here |
|---|---|---|---|---|
| 25 | Forward P/E and PEG | Weekly | Claude search | Stored with source, date and **the fiscal year it refers to** — a forward P/E without a stated year is meaningless. |
| 26 | Price target, rating skew, next earnings date | Weekly | Claude search | The earnings date is the operationally useful one: opening a position days before a print should be deliberate. |

The six buckets are defined by **what each number is compared against** — nothing, its own fundamentals, its own price history, another security, the environment, or human opinion. That's what keeps them mutually exclusive, and why Valuation sits apart from Business: the split is what lets us say "great company, wrong price".

Deliberately outside all six, and therefore absent: ownership and flows (insider, institutional, short interest), the options and volatility surface, and catalysts beyond the earnings date.

### On the hourly series

We hold **two years of hourly bars**, not three months — Yahoo returns roughly 3,500 per ticker back to September 2024, and storing them costs nothing. The *reported* parameter is the standard 3-month hourly RSI; the extra depth means later trend work needs no re-fetch, and the Wilder smoothing gets proper warm-up rather than starting cold inside the display window.

### How we know the numbers are right

Almost every technical parameter is computed by us from Yahoo bars, so a quiet arithmetic error would propagate into colour, rules and alerts without ever looking wrong. Two failure modes, handled differently.

**Bad inputs.** Missing bars, unadjusted splits, bad ticks, holiday gaps. Caught by bar-count checks against expected trading days, sanity bounds on implausible single-day moves, and periodic spot-checks against an independent source.

**Bad maths.** The likelier one, because the standard indicators all have more than one accepted definition:

| Indicator | The trap |
|---|---|
| RSI | Wilder smoothing vs a simple average of gains/losses. Different numbers, both called RSI. |
| EMA | Seeded from an SMA vs from the first close. Diverges for the early window. |
| Realized volatility | Log vs simple returns; 252 vs 365 annualisation; sample vs population standard deviation. |
| SMA | What to do before enough history exists — null, or a shorter average. |

Four things keep it honest:

- **Pinned conventions.** Every variant we pick is written down, so it's a decision rather than an accident. Not settled yet — see below, which is a launch blocker.
- **Golden-value tests.** A handful of tickers and dates whose correct values we've verified against a reference, committed as tests. The highest-value check: it catches the "plausible but wrong" class that invariants miss.
- **Invariant tests.** RSI within 0–100. A 200-day SMA between the min and max of its last 200 closes. Realized vol non-negative. Cheap, and they catch whole categories of bug.
- **Cross-implementation check.** Each indicator computed a second way in a test — our SQL against a reference library — and asserted to agree. Catches window-function mistakes that look fine in isolation.

The limit, stated plainly: **there is no single canonical RSI.** Platforms differ. The achievable goal isn't "matches everyone" but "internally consistent, documented, matching a named reference implementation" — enough to trust a threshold we set ourselves.

### Parameter definitions — to be pinned before launch

**A launch blocker, and not decided yet.** Several parameters have more than one accepted definition, and two implementations can both be "correct" while producing visibly different numbers. Ship before agreeing these and we'll spend the first month arguing with the dashboard instead of using it.

The target: **match what Robinhood or TradingView shows**, so a number here is checkable against a screen we already look at. Where that isn't possible, say so on the column rather than diverging quietly.

**One already decided: all extremes use intraday highs and lows, never closes.** The all-time high is the highest price the stock actually traded at — the whole reason we store full OHLCV. For Micron that's **$1,255.00** against **$1,213.56** on a closing basis, a 3% gap that every "% off high" threshold would inherit. Same rule for the 52-week high and the all-time low.

Two notes. The long-history series and the daily series were checked against each other and agree — both return $1,255.00 for Micron — so the extremes sit on one consistent basis. And the series is split- and dividend-adjusted, which isn't really a choice: we compare against today's adjusted price, so an unadjusted historical high would measure against a different scale.

Definitions that materially change the number and are **still open**:

| Parameter | What varies |
|---|---|
| RSI (all three timeframes) | Wilder smoothing vs a simple average of gains and losses. TradingView uses Wilder. Also which price feeds it — close vs HLC3. |
| EMA (weekly 21) | Seeded from an SMA vs from the first close. Diverges noticeably early. |
| Realized volatility | Log vs simple returns; sample vs population standard deviation; 252 vs 365 annualisation; window length. |
| % off 52-week high | 52 calendar weeks vs 252 trading days. |
| Weekly bars | Which day the week starts, and whether the current partial week counts. Changes every weekly parameter downstream. |
| Trailing P/E | GAAP vs non-GAAP earnings, basic vs diluted share count. **The largest divergence here** — consumer apps typically show non-GAAP. |
| Net debt / EBITDA | EBITDA isn't a GAAP measure at all. Every vendor defines it differently. |
| ROIC | At least five accepted definitions of invested capital. |
| FCF yield | Whether capex includes capitalised software and leases; market cap vs enterprise value in the denominator. |
| EV / Sales | Whether enterprise value includes operating lease liabilities. |
| Revenue growth | Trailing twelve months vs quarterly year-on-year; as-reported vs restated. |
| Share count change | Basic vs diluted vs cover-page shares outstanding. |
| Relative strength | Price ratio vs difference of returns; calendar months vs trading days. |
| Analyst target gap | Mean vs median target, and over which analyst set. |

One caveat shapes how far this can go: **Robinhood and TradingView don't agree with each other either.** For technicals, matching is realistic — TradingView documents its formulas. For fundamentals it often isn't, because consumer apps buy adjusted vendor data while we compute from GAAP filings. Our P/E will differ from Robinhood's whenever they use non-GAAP, and no amount of care closes that.

So the practical rule: **match TradingView for technicals; for fundamentals match ourselves** — consistently, documented, with the divergence noted on the column. Chasing a number we structurally cannot reproduce is worse than showing a defensible one and saying why it differs.

Output is `docs/DEFINITIONS.md`, agreed before launch: one line per parameter giving the formula, price input, window, and the reference we're matching.

### Colour coding

Colour does the work a ranking would otherwise do, so it's designed rather than decorated. It's driven by **norms we define** — explicit thresholds per parameter, not a statistical ramp:

| Example norm | Shades when |
|---|---|
| Daily RSI | below 30, or above 70 |
| Weekly RSI | below 45, or above 65 |
| % off all-time high | more than 30% below |
| Net debt/EBITDA | above 4× |
| Weekly close vs 200W SMA | within 10% above it |

Norms live in **editable config, not code**, so tightening a threshold is a one-line change after a week of looking at the sheet.

Two properties keep this honest even though a threshold is inherently a judgment. It is **our judgment, stated explicitly, rather than the tool's implied one** — the dashboard has no view; we supply ours and can see exactly what we supplied. And **norms are set at both ends where both ends matter**, so a name stretched far above its normal range stands out as much as one that has fallen below it. That's what makes the sheet work for taking profits, not only entries.

Three rules keep it readable:

- **Numbers are always visible.** Colour is a second channel, never the only one, so the sheet works for a colourblind reader, in print, and in a screenshot.
- **Status colours are reserved** and separate from norm shading — factual states only, never judgments: data is stale, a filing is missing, a searched value is past its refresh window. Each carries an icon and a label, never colour alone.
- **The palette gets validated, not eyeballed** — checked for colourblind separation and contrast on both light and dark backgrounds before it ships.

In Phase 2 the norms and the rule engine become the same object: any rule can paint a cell, so defining a rule and defining a colour stop being two jobs.

---

## 7. Watchlist — first list

36 companies and 4 indices, weighted toward semiconductors and AI infrastructure because that's where the thematic conviction is, with large-cap bellwethers for breadth. **Bold** = bellwether. A starting point, not a commitment — adding or cutting one is a one-line change.

| Theme | Tickers |
|---|---|
| Semiconductors | **MU**, **NVDA**, **AVGO**, **TSM**, AMD, INTC, QCOM, TXN, ARM, MRVL, SNDK, CRDO, ALAB |
| Semi equipment | **ASML**, AMAT, LRCX, KLAC |
| AI infra & storage | WDC, STX, SMCI, DELL, VRT, ANET |
| Mega-cap tech | **AAPL**, **MSFT**, **GOOGL**, **AMZN**, **META**, TSLA |
| Bellwethers outside tech | **JPM**, **WMT**, COST, **CAT**, GE, **XOM**, UNH |
| Indices (context, not traded) | ^VIX, ^GSPC, ^NDX, ^SOX |

---

## 8. What we checked before proposing it

Each data requirement was tested against the live endpoint rather than assumed. Two came back negative, and the plan is built around those answers.

**✅ Hourly bars, two years deep.** True hourly granularity, keyless — roughly 3,500 bars per ticker back to September 2024. An earlier draft claimed hourly history was capped at three months; that was wrong, and tested. We store the full two years and report the standard 3-month hourly RSI from it.

**✅ Full listing history for all-time high and low.** Back to first trade — 1984 for Micron, 1980 for Intel. Returned at quarterly resolution, but each candle carries its own high and low, so the extreme is *exact*, not approximated. **Caveat:** split- and dividend-adjusted, so an adjusted all-time high won't match the nominal price anyone remembers. Label the column as adjusted.

**✅ Point-in-time fundamentals.** SEC XBRL returns as-reported figures stamped with the date each became public. That's what makes a fundamental replay honest.

**❌ Analyst estimates and price targets, free.** Yahoo's fundamentals and quote endpoints both refuse unauthenticated requests. No keyless source exists for forward P/E, PEG, expected growth, consensus or revisions. Hence the searched columns. The gap to analyst target is a reasonable read on whether a name looks cheap — it just can't be *measured*, so it narrows rules rather than firing them.

**❌ Market data from our own dev machines.** Every provider tested is unreachable from an AI coding sandbox. This is the constraint that put fetching inside the database platform — worth knowing before either of us writes a fetch script locally and wonders why it hangs.

---

## 9. Phase 2 — rules, alerts and backtesting

Phase 1 gets twenty-six parameters in front of us reliably, shaded against norms. Phase 2 turns a sheet we read into a system that tells us things.

### What a rule is

A named condition over one or more parameters that we want to be told about:

- *"MU pulls back"* — gap to all-time high greater than 25% **and** weekly RSI below 45
- *"Semis oversold"* — daily RSI below 30 **and** price above the 200-week SMA, across all semiconductor names
- *"Cheap against the street"* — weekly RSI below 35 **and** more than 20% below analyst target
- *"Getting stretched"* — weekly RSI above 65 **and** trailing P/E percentile above the 80th

Rules combine parameters with thresholds and boolean logic, stored as data rather than code, so adding one never requires a deploy.

A rule that fires every day is a broken rule, not a signal. Conditions should be tight enough that a hit is worth opening the laptop for — a discipline on us when writing them, not something the system enforces.

### Scope and ownership

| | |
|---|---|
| **Scope** | One ticker, a named group, or all of them. "All" is an explicit option, not a workaround. |
| **Composition** | Any number of parameters, combined with AND / OR. |
| **Naming** | Every rule is named. An unnamed rule is unmaintainable six weeks later, when nobody remembers what it was for. |
| **Who can create** | Anyone with an account. Rules cost nothing to evaluate, so they don't need the owner-only guardrail. |
| **Who can trigger a refresh or search** | Owners only. That distinction stays. |

### Backtesting

Every rule gets a **backtest trigger**: run it over history and show what happened next, scored against buy-and-hold on the same universe and window. The engine is a pure function of ticker and date, so replay is the same code with the date argument opened up, not a second implementation.

A rule can only be replayed over parameters we have history for:

| Parameter family | History | Replayable |
|---|---|---|
| Price, momentum, trend | 10 years, plus full history for extremes | Yes |
| Fundamentals from SEC | Point-in-time, stamped with filing dates | Yes — genuinely, without hindsight bias |
| Searched — analyst target, forward P/E, PEG | None yet. Collection starts on day one. | Not yet |

**Composite rules get a partial backtest rather than none.** Take *"weekly RSI below 35 and more than 20% below analyst target"*. We can't replay the whole rule, but we can replay the RSI leg, which gives the base rate the rule starts from: *"the measurable half returned X over six months; the target filter narrows it further by an unmeasured amount."* Considerably more useful than refusing to run it.

Two things to be precise about. The measurable leg gives an **upper bound on how often the rule could have fired**, not an estimate of how the filtered version performed — we don't know what targets were then, so we can't apply the filter retrospectively. And since the searched column refreshes weekly, the filter is at most a week fresh when it fires.

This is why searched values are **appended, never overwritten**. In twelve months we'll have twelve months of target history and those rules become genuinely replayable. Overwriting throws that away for no saving.

### Build order, and where the UI fits

Rule creation needs a UI eventually — "anyone can create a rule" is false if it requires a pull request. But the UI is a form and the engine underneath is the hard part, so:

**Phase 2a — the engine.** Rule storage, evaluation, colour integration, alerts, the backtest function. Rules authored as JSON through Claude and merged as PRs. Deliberate rather than lazy: authoring twenty real rules by hand is how we find out whether the schema is right, and a UI built on an untested schema gets rebuilt. Version history and review come free.

**Phase 2b — the UI.** Parameter picker, threshold inputs, ticker selection including "all", name field, save, and a backtest button per rule. Built on a schema that has already survived real use.

The tradeoff: between 2a and 2b, rule creation is limited to whoever is comfortable opening a pull request. For two people that's fine. It stops being fine the moment a third person wants their own rule — and that, not a date, is the trigger for building 2b.

---

## 10. Open decisions

**Settled:** no paid data feed — forward P/E and PEG come from Claude search. No score and no ranking in v1; colour carries the scanning load. Relative and Market deepened from one column each to four and three. Extremes measured on intraday highs and lows.

Still open:

1. **How many tickers?** 36 is comfortable. Past roughly 60 the hourly pull and free-tier limits start to matter, and the page stops being scannable in a minute.

2. **How often should the hourly series refresh?** Proposed twice a day, midday and close. Every market hour is affordable (280 requests/day) but probably pointless for a tool we open in the morning.

3. **Does the searched column survive contact with reality?** Forward P/E scraped weekly may prove too inconsistent between sources to be worth the column width. Give it a month, then keep it, tighten the sources, or drop it.

4. **How do we onboard a third viewer?** Roles are owner and viewer, but we haven't decided whether viewers are invited individually or anyone with the link can read.

5. **What breaks first?** Most likely the unofficial price endpoint changing shape without warning. The nightly smoke test tells us fast; the question is whether we want a fallback source ready or are content to fix it when it happens.

---

*Research tooling, not investment advice. Every signal is a prompt to look, not an instruction to trade.*
