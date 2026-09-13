# Swing Tracker — v1 Build Proposal

An end-of-day dashboard that watches a fixed list of companies we already have a thesis on, and tells us when one of them reaches a moment worth acting on.

| | |
|---|---|
| **Revision** | **v2 — 13 September 2026** (first draft 17 August 2026) |
| **Horizon** | Swing / LEAPS, 6 months+ |
| **Team** | Two builders, ~10 readers, Claude coding on each end |
| **Repo** | Shared GitHub, public |
| **Scope** | 26 parameters × 36 tickers + 3 index series |
| **Data** | Polygon Stocks Starter ($29/mo) + FRED + SEC XBRL |

> **This document is the product surface: what the thing IS.** It is the only file the change
> matrix lets a scope change touch, and nothing else may contradict it. It does **not** track build
> status — `docs/FEATURES.md` does that, and `CLAUDE.md` carries the current state in a paragraph.
>
> **What changed in v2 is listed at the end**, under Revision history. Three things moved enough to
> be worth knowing before reading anything else: the price source changed vendor, v1 has **one**
> daily clock rather than four, and there is **no user-led refresh and no login** — the dashboard is
> open and its schedule is set by us.

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

- **A scheduled data pipeline that is the only path.** One clock, after the US close on weekdays: fetch, then rebuild the parameters. It runs unattended, every run is recorded, and there is no manual alternative — see *No user-led refresh* in section 4 for why that is a choice rather than a shortcut.
- **Full OHLC, not just closes** — anything computed from range (RSI, true range, intraday extremes) is wrong without it. Index series are the exception and carry closes only, which no parameter of theirs needs.
- **Three RSI timeframes** — weekly frames the trade, daily times it, hourly says whether today is a bad moment to click. Hourly needs session-aligned bars the vendor does not publish directly, so it lands after the first two.
- **Extremes over stored history, labelled as such.** Five years, not all time. INTC, QCOM and GE peaked in 2000 and sit outside any tier we would plausibly buy, so the column is named for the window it actually covers rather than claiming more.
- **Searched columns** — forward P/E, PEG, price targets and consensus aren't available from any free feed, and we're not paying for one. A Claude web search fills them weekly, stamped with source, date and fiscal year.
- **A properly deployed app** — a real front end reading live from the database, on a stable URL. Desktop-first: the grid is a wide table and we're not pretending otherwise.
- **Open to anyone with the link, with no login.** About ten people read it, on their own devices, and none of them should have to hold a password. The page is public; the database is not — the server reads it and returns HTML, so the browser never touches Postgres.
- **Freshness stated on the page, not assumed.** One run a day, no retry, no refresh button: the realistic failure is people reading stale numbers that look current. The page carries a last-updated stamp and says so plainly when the data is behind.
- **A daily digest by email** — the phone surface. Three lines on which names crossed a norm today, with a link. When none did, it says so.
- **Colour-coded against norms we set** — thresholds we define per parameter decide what gets shaded. They live in an editable config file, are compared in the database so the grid, the digest and later the rule engine share one definition of "outside normal", and carry **no score and no ranking**.
- **Add a ticker without a UI** — the watchlist is a file in the repo. Add a line, commit, next run backfills its history. Norms work the same way.
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

**One constraint shapes the whole design:** AI coding sandboxes have no network route to market-data providers — every one of them fails at the proxy. So the fetching cannot live where we write the code. It lives in the database platform, which does have open internet access.

```
  1. FETCH            2. STORE           3. COMPUTE          4. PUBLISH
  Database-side  →    Postgres      →    SQL parameters  →   Server-rendered
  functions, on       Daily bars,        Same query serves   page, one URL,
  a schedule          index series,      tonight's scan      open, no login,
  we control          fundamentals       and a 10y replay    plus email digest
```

The third column is the one worth pausing on. **The same query serves tonight's scan and a ten-year
replay**, because every parameter is computed for every (ticker, date) rather than only for today.
That is what makes a backtest a `WHERE` clause instead of a second implementation that drifts from
the first — and it is the single decision the rest of the architecture is arranged around.

### The clock

**v1 runs on one clock.** After the US close on weekdays: fetch every symbol, then rebuild the parameter layer a few minutes later. That is the whole pipeline.

| Job | Runs | What it does |
|---|---|---|
| **Ingest** | Weekdays, after the close and the vendor's publication delay | Full OHLCV for every equity, closes for the index series. One pass, whole watchlist. |
| **Rebuild** | Fifteen minutes later | Recomputes every parameter for every ticker and date, so the grid is an index scan rather than a computation. |

Two design points that are easy to get wrong later:

**The two jobs are separate, not chained.** Chaining would guarantee the rebuild only ever sees fresh data, but it would collapse two failures into one silence — a fetch that dies leaves the rebuild untouched with nothing to distinguish it from a quiet day. Separate jobs mean a failed fetch and a stale parameter layer are two visible problems.

**A scheduler reporting success is not the same as data arriving.** The fetch is dispatched asynchronously, so the scheduler records success the moment it *asks*. What actually answers "did today work" is the run log and the freshness check, in that order. This distinction has bitten this project repeatedly in other forms and is written down wherever it applies.

More clocks arrive with the parameters that need them — a filings check when fundamentals land, a weekly sweep for the searched columns, an intraday clock if hourly columns prove worth watching. Each is a schedule entry, not an architecture change.

### No user-led refresh, and what that costs

There is **no "Refresh now" button**, for anyone. The schedule is set by us and is the only way data moves.

That deletes a whole category of design — queueing, coalescing, cooldowns, per-user rate limits, a global daily cap, and the question of who is allowed to press it. None of that has to exist, and none of it has to be got right.

**What it costs is honesty about staleness.** With one run a day and no retry, a failure means a stale day, and nobody looking at the page can do anything about it. So staleness cannot be a detail:

- The page carries a **last-updated stamp**, always visible.
- It shows a **clear banner** when the data is older than it should be.
- The threshold for "older than it should be" is a norm in config, not a number buried in the frontend.
- The database decides it, not the browser — the same judgment then serves the grid, the digest, and anything later.

Ten people reading silently stale numbers that look current is the worst failure this design permits. Making it loud is the compensating control for removing the button.

### Guardrails on the searched columns

These are the only part of the system that **costs money per use and writes to shared state** — a bad value is visible to everyone, not just whoever triggered it. So:

- **Not triggerable from the page at all.** v1 has no login and no user-initiated actions, so this is enforced by there being no route rather than by a role check. When the searched columns land they run on their own schedule, like everything else. If a manual trigger is ever wanted, it needs an identity model first — that is the reason to add one, and the only one so far.
- **Capped per day** globally, since a schedule can misfire as easily as a person can.
- **Every value stores provenance** — number, source URL, retrieval date, and the fiscal year it refers to. A forward P/E without a stated year is meaningless, and sources use different consensus sets.
- **Usable in a rule as a filter, never as the trigger.** A searched value can narrow a rule as an AND condition — weekly RSI below 35 *and* more than 20% below target — but never fires one alone. It's a slow-moving weekly number: a standing eligibility condition, not something that changes today.
- **Appended, never overwritten.** Every retrieval adds a row. Costs nothing now, and it's the only way we accumulate the history that makes these columns backtestable later.
- **Stale values decay visibly.** A target retrieved five weeks ago shouldn't look like one retrieved yesterday.

### Built so data sources can be swapped, not rebuilt

We're starting keyless and free. If the watchlist grows to hundreds of names, or we want real consensus estimates, we should be able to buy a feed and plug it in — **without touching parameters, rules, norms or the dashboard.** That only holds if the seam is designed in now; retrofitting means rewriting the layer everything else sits on.

- **A provider interface, not provider-shaped code.** Every source implements the same contract — *bars for this symbol over this range*, *this fundamental for this company*. A paid provider becomes a third file, not a refactor.
- **Nothing downstream knows where a number came from.** Parameters compute from tables, and tables don't encode a vendor.
- **Every stored value carries its source.** A `source` column on every row, so a migration is auditable — we can run both providers side by side and compare before cutting over.

This has already been tested once, in the way that counts: the price vendor changed entirely — a different company, a different API, a different rate limit and a different history depth — and the change landed in one file plus two constants, with the golden values reproducing to within 1.5×10⁻⁴ afterwards. The seam works.

What constrains scale is not the schema. Measured: a full history fetch costs about a fifth of a second per symbol, so a few hundred names fit inside one scheduled run. Past that the answer is bulk files rather than per-symbol requests, which is a change to one provider file.

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
| Prices, equities | Polygon / massive.com, Stocks Starter | $29/month. Keyed, published limits, unlimited calls, five years of history. Replaced a keyless endpoint that blocked our egress IP permanently after a single burst — a key identifies us instead of our address, which is the actual lesson. |
| Index series | FRED (St. Louis Fed) | Free, official, documented. Carries VIX and the 3-month VIX, without which there is no term structure and no "the market is peaking" signal. Daily closes only, which is all these parameters read. |
| Fundamentals | SEC XBRL | Free, no key, stamped with filing dates — point-in-time, which is what lets us replay a fundamental rule honestly. |
| Searched columns | Claude web search | Weekly, or on demand for one ticker. Writes value, source, date, fiscal year. Owner-only. |
| Front end | Next.js on Vercel | A real deployed app reading live from the database, desktop-first. Free tier, stable URL, deploys on push. |
| Identity & roles | **None in v1** | The page is open and read-only, so there is nothing to authorise. The server reads the database and returns HTML; the browser never queries Postgres, so no read policy is load-bearing and no key reaches a viewer. Identity gets added when something needs to distinguish between people — per-person watchlists, or a manual trigger. Not before. |
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

Hourly is the one timeframe that cannot simply be fetched, and the reason is worth stating because it looks like an easy column.

The vendor publishes hour aggregates aligned to **clock hours**, including extended-hours trading. TradingView — the reference every number in this system is anchored to — aligns its 1-hour bars to the **09:30 session open** and excludes extended hours. Those are different bars, so they produce different RSI values. Hourly RSI is read against a 30/70 threshold, and bar alignment moves a value across a threshold.

So hourly bars are **built, not fetched**: minute aggregates rolled up into session-aligned hours. The depth is worth taking generously while we are there, so the Wilder smoothing warms up long before the window we display rather than starting cold inside it. Until that lands the column is absent, which is the honest state — a clock-hour RSI labelled as an hourly RSI would be the exact failure this project spends most of its effort avoiding.

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

**⚠️ Full listing history for all-time high and low — no longer true, and the reason matters.** This was checked against the keyless vendor we have since abandoned (v2, and decision 0019). The current plan carries **five years**. INTC, QCOM and GE all peaked in 2000 and sit outside it, so the parameter measures the highest price *we hold*, is named `pct_off_high_stored` for exactly that reason, and must never be presented as an all-time figure. A one-time deep backfill would fix it and is not built. The original caveat still stands for whatever we do hold: prices are split-adjusted, so a historical high will not match the nominal number anyone remembers.

**✅ Point-in-time fundamentals.** SEC XBRL returns as-reported figures stamped with the date each became public. That's what makes a fundamental replay honest.

**❌ Analyst estimates and price targets, free.** Yahoo's fundamentals and quote endpoints both refuse unauthenticated requests. No keyless source exists for forward P/E, PEG, expected growth, consensus or revisions. Hence the searched columns. The gap to analyst target is a reasonable read on whether a name looks cheap — it just can't be *measured*, so it narrows rules rather than firing them.

**❌ Market data from our own dev machines.** Every provider tested is unreachable from an AI coding sandbox. This is the constraint that put fetching inside the database platform — worth knowing before either of us writes a fetch script locally and wonders why it hangs.

---

## 9. Phase 2 — rules, alerts and backtesting

Phase 1 gets twenty-six parameters in front of us reliably, shaded against norms. Phase 2 turns a sheet we read into a system that tells us things.

### What a rule is

A named condition over one or more parameters that we want to be told about:

- *"MU pulls back"* — gap to its stored high greater than 25% **and** weekly RSI below 45
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
| **Who can trigger a refresh or search** | Nobody, from the page. v1 has no user-initiated actions at all, so this is a property of the architecture rather than a permission. If Phase 2 wants a manual trigger, it brings an identity model with it. |

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

**Settled since the first draft**, each with its reasoning in `docs/DECISIONS.md`:

- **We do pay for data** — $29/month, and the trigger was concrete rather than aspirational: the 200-week SMA is one of the 26 parameters and could not be computed at all on two years of history. Forward P/E and PEG still come from Claude search; no feed sells us those at a price worth paying.
- **The dashboard is open, with no login.** About ten readers on their own devices, none of whom should need a password for a page of public-market numbers.
- **No user-led refresh.** We set the schedule.
- **Norms are compared in the database**, so the grid, the digest and the future rule engine share one definition of "outside normal" and history stays queryable.
- **No score and no ranking in v1**; colour carries the scanning load.
- **Extremes measured on intraday highs and lows**, over stored history, labelled with the window they actually cover.
- **`rs_vs_sox` dropped.** No free source carries the PHLX Semiconductor Index, and a proxy ETF would have meant reporting one thing under another thing's name.

Still open:

1. **How many tickers?** 36 is comfortable and the page stays scannable in a minute. The technical ceiling turned out to be far higher than assumed — a few hundred names fit inside one scheduled run — so this is now a **legibility** question, not a capacity one. The likely answer is sector ETFs and a broader universe, which is a different product shape and deserves its own decision.
2. **Sector exposure: real indices, or the ETFs that track them?** ETFs are covered by the plan we already pay for, carry full history, and are the things one can actually buy. They are also not the indices — so if we use them the parameter must be named for the ETF. Naming it otherwise is the failure mode this whole document keeps circling.
3. **NYMO, and whether we can honestly have it.** No retail feed sells the McClellan Oscillator as data. It can be computed from whole-market advance/decline counts, but the published version counts *all* NYSE issues — preferreds, closed-end funds, ADRs — so a version over our own filtered universe is a near-neighbour that diverges exactly at the extremes one would want to trust it at. Either we compute it and name it ours, or we do without.
4. **Does the searched column survive contact with reality?** Forward P/E scraped weekly may prove too inconsistent between sources to be worth the column width. Give it a month, then keep it, tighten the sources, or drop it.
5. **Which columns, if any, want intraday updates?** "Some of them" is not yet a list, and the list determines how many clocks exist. Worth answering only after we have looked at the daily grid for a while.
6. **The eight fundamental definitions.** GAAP versus non-GAAP, which EBITDA, which invested capital, and so on — listed in `docs/DEFINITIONS.md` §7. These are the largest divergence from what consumer apps show, and each needs a judgment call before any of that code is written.
7. **What breaks first?** The keyless endpoint that was the obvious answer is gone, along with the risk. The honest candidates now are a vendor changing a response shape without notice, and the scheduled run failing quietly on a day nobody looks. The second is the one we have built for.

---

## Revision history

Git holds the full diff; this is the summary of what a reader of the previous version would find
changed. Every entry has its reasoning in `docs/DECISIONS.md`.

### v2 — 13 September 2026

| Changed | Was | Now |
|---|---|---|
| **Price source** | Yahoo chart API, keyless and free | **Polygon / massive.com Stocks Starter, $29/month** — the keyless endpoint blocked our egress IP permanently after one burst of requests. Index series moved to **FRED**. |
| **History depth** | "Full listing history", so a true all-time high | **Five years.** INTC, QCOM and GE peaked in 2000 and sit outside it, so the parameter is named for the window it covers. The purchase was triggered by the 200-week SMA being uncomputable on two years. |
| **Clocks** | Four — hourly, daily, SEC-check, weekly | **One**, after the close on weekdays, plus a separate rebuild. More arrive with the parameters that need them. |
| **Refresh** | A "Refresh now" button with queueing, cooldowns and a global daily cap | **None.** The schedule is the only path. Staleness is stated on the page instead. |
| **Identity** | Owner and viewer roles enforced by row-level security | **No login.** The page is open and read-only; the server reads the database and the browser never touches it. |
| **Readers** | Two | **About ten**, on their own devices. |
| **Norms** | Editable config | Still editable config, but now **synced to the database and compared there**, so the grid, the digest and the rule engine cannot drift apart. |
| **Hourly RSI** | Available from the price feed | **Built, not fetched** — session-aligned bars rolled from minute data, because clock-hour bars are different bars and hourly RSI is read against a threshold. |
| **`rs_vs_sox`** | A parameter | **Dropped.** No free source for the index, and a proxy would have meant mislabelling. |
| **`pct_off_ath`** | The norm's name | **`pct_off_high_stored`** — norms match parameters by name, so the old key would have coloured nothing, silently and forever. |

### v1 — 17 August 2026

First draft. Original scope: 26 parameters × 40 tickers, four clocks, keyless free data, two roles,
a manual refresh trigger.

---

*Research tooling, not investment advice. Every signal is a prompt to look, not an instruction to trade.*
