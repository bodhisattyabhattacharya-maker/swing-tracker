# Glossary

Shared vocabulary. Cheap file; it stops two people building two meanings for one word.

| Term | Means here |
|---|---|
| **Parameter** | One of the 26 tracked numbers. Computed on a schedule. Not a signal. |
| **Norm** | A threshold we define on a parameter that decides whether a cell gets coloured. Our judgment, stated explicitly. |
| **Rule** (Phase 2) | A named condition over one or more parameters that we want to be alerted on. |
| **Signal** | One firing of a rule on one ticker on one date. |
| **Episode** | A deduplicated run of consecutive signals. A rule firing 60 days straight is ~1 episode, not 60 — use episodes when judging sample size. |
| **Clock** | A refresh schedule. v1 runs **one** — after the close on weekdays — plus a separate rebuild. Hourly, SEC-check and weekly clocks arrive with the parameters that need them. |
| **Baseline** | Buying any watchlist name on any random day over the test window. The bar a backtest must beat. |
| **Edge** | A rule's average forward return minus the baseline's, at the same horizon. |
| **Searched column** | A value obtained by Claude web search, not an API. Displayed with provenance; usable as a rule filter; never a trigger; not backtestable. |
| **Owner / viewer** | ~~Two roles enforced by RLS.~~ **Not in v1** — the dashboard is open with no login and has no user-initiated actions, so there is nothing to authorise (PROPOSAL §4). Kept because Phase 2 may reintroduce it; if it does, that is the reason to add identity, not the other way round. |
| **Completed week** | The last fully-closed weekly bar. All weekly parameters read this, never the current partial week. |
| **Warm-up floor** | The minimum bars before a recursive indicator stops reflecting its seed value. Below it, suppress the number rather than showing it. Floors are listed in `DEFINITIONS.md` §4 — **not** `CONSTRAINTS.md`, which is about the outside world. |
| **Golden value** | A known-correct figure for a specific ticker and date, committed as a test fixture. Catches the 'plausible but wrong' errors that invariant checks miss. |
| **Provider interface** | The contract every data source implements, so a paid feed can replace a free one without touching parameters, rules or the dashboard. |
| **Theme** | A ticker's peer group in `watchlist.yml`. Sector-relative ranks are computed within a theme, so a theme needs several members to mean anything. |
| **Hard stop** | An action requiring in-session confirmation every time — deploy, migration, external message, anything irreversible. Backed by `.claude/settings.json`, not just by asking. |
| **Tag** | A ticker's granular label in `watchlist.yml`, for display and filtering only. Never used in a calculation — that is what `theme` is for. |
| **Feature** | A stored column derived from bars — what a parameter is made of, or is. `daily_features` is the daily set. "Parameter" is the user-facing number on the grid; "feature" is the column it comes from, and for most of them they are the same thing. |
| **Seed-decay flag** | A boolean beside a recursive indicator (`rsi_daily_seed_ok`) saying whether it has cleared its warm-up floor. False means computed-but-still-partly-its-seed: show it if you must, never colour a cell on it. |
| **Invariant check** | A check phrased as "count the rows that violate this", so the expected answer is always zero. Preferred to checking an average, where a new violation can hide. |
| **MISSING** | A verify-script status distinct from both PASS and FAIL: the row the check needed does not exist, so nothing was verified. Never treat it as a pass — see `INCIDENTS.md` for why this project is blunt about it. |
| **NOPAT** | Net operating profit after tax — `OperatingIncomeLoss × (1 − effective tax rate)`. The numerator of our ROIC. Deliberately operating income, not net income, so capital structure and one-off items stay out of a return-on-capital number. |
| **Invested capital** | Ours is `total debt + total equity − cash`. There are at least five accepted definitions; this is the recognisable one and the column says so. ROIC is definition-sensitive and comparing ours to a vendor's is comparing two different measures. |
| **Cover-page shares** | `dei:EntityCommonStockSharesOutstanding` — the share count on a filing's cover, as of the filing date. A point-in-time count, unlike the basic and diluted weighted averages, which are averages over a period built for EPS and smear a buyback across the quarter it happened in. |
| **Searched column** | A parameter collected by web search rather than computed from a feed — analyst target gap, forward P/E, PEG. Carries its own value, source and date, and is never mixed into the SEC-derived fundamentals: one is measured, the other is someone's opinion. |
| **As-reported** | The figure as it was filed, not as later restated. Using restated numbers would let a backtest standing in 2025 see a 2026 correction, which is the point-in-time property hard constraint 4 buys and decision 0002 protects. |
| **Fund** | An ETF on the watchlist. `tickers.is_fund`. Trades, charts and oscillates like a stock, so every price parameter applies; has no income statement, so every fundamental is **not-applicable** rather than missing. Distinct from **index** — a fund is a grid row, an index never is. |
| **Index** | A context series (^VIX, ^VIX3M, ^GSPC). `tickers.is_index`. Never a grid row, never ranked, never in breadth; it exists to be the thing other numbers are measured against. |
| **Not applicable** | A cell that is blank because the question does not apply to this security — a fund's P/E, a `rankable: false` theme's sector rank. Must render differently from *missing* and from *null*: one is a fact about the domain, the others are facts about the data. |
| **MA stack** | The ordering of close, EMA21, SMA50 and SMA200 as one categorical chip: Full bull, Full bear or Mixed. A shape, not a score — it says how the averages are arranged, never what to do about it. |
| **Tone** | A signal chip's colour class — bull, bear or neutral — derived from its LABEL. Deliberately not a norm verdict: a verdict comes from a threshold in `config/norms.yml` and a tone comes from the category, so editing a norm can never restyle a chip. |
| **Bars since** | Trading bars elapsed since an event, 0 on the event's own bar. Never calendar days — a calendar gap spans a different number of sessions depending on where the weekends fall (decision 0035). Null means the event is not in the history we hold. |
