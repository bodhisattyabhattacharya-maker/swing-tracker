# Parameter Definitions

**Reference anchor: TradingView Pine Script v5/v6 built-ins.** Where TradingView defines an indicator, we match it exactly. Where it doesn't (realized volatility, relative strength, sector ranks), we define it here and say so.

Every technical definition below has been verified against an independent implementation — see [Verification](#verification) at the end for the numbers.

Status: **technicals settled.** Fundamentals still open, listed at the end.

---

## 1. Primitives

Everything else is built from these three. Getting them right is the whole game.

### SMA — simple moving average

```
sma(src, n)[t] = (1/n) · Σ src[t-i]   for i = 0 … n-1
```

Returns **null** before `n` bars exist. We never return a shorter average as a stand-in — a 200-day SMA computed from 60 bars is a different statistic wearing the same label.

### RMA — Wilder's smoothing (`ta.rma`)

```
α    = 1 / n
seed = sma(src, n)          at bar index n-1
rma[t] = α · src[t] + (1 - α) · rma[t-1]
```

**This is the one that must not be got wrong.** The common alternative — a plain rolling average of gains and losses — is also called "RSI" in the wild and produces materially different numbers. Measured on Micron: **9.4 RSI points apart today, 5.9 points on average over the last 250 bars, 27.3 points at worst.** With thresholds at 30 and 70, that is the difference between a signal firing and not firing.

### EMA — exponential moving average (`ta.ema`)

```
α = 2 / (n + 1)
ema[t] = α · src[t] + (1 - α) · ema[t-1]
```

**Seeding:** TradingView's published `pine_ema` pseudocode seeds with the first source value. We seed with `sma(src, n)` instead. This is deliberate and safe, because **the seed is a transient that decays geometrically as (1-α)^bars** — it is not a permanent difference like the RMA choice above. Verified empirically: after 320 bars the two seeding methods differ by 8×10⁻¹⁶ relative, i.e. floating-point noise. See warm-up requirements in §4.

---

## 2. RSI

```
change[t] = close[t] - close[t-1]
gain[t]   = max(change[t], 0)
loss[t]   = max(-change[t], 0)

avgGain = rma(gain, 14)
avgLoss = rma(loss, 14)

RS   = avgGain / avgLoss
RSI  = 100 - 100 / (1 + RS)
```

- **Source is `close`.** Not HLC3, not typical price.
- **Length is 14** on all three timeframes.
- **Edge cases:** `avgLoss = 0` → RSI = 100. `avgGain = 0` and `avgLoss > 0` → RSI = 0. Both are defined explicitly rather than left to produce a division error or a NaN.
- Null until 14 changes exist (i.e. 15 bars).

Applied identically on hourly, daily and weekly bars. The only difference between the three is which bar series feeds it.

---

## 3. Parameter-by-parameter

### Price behaviour

| Parameter | Definition | Notes |
|---|---|---|
| **RSI hourly** | `rsi(close, 14)` on hourly bars | Reported as the standard 3-month hourly RSI. Computed on the full stored 2-year hourly series, so no warm-up problem. |
| **RSI daily** | `rsi(close, 14)` on daily bars | |
| **RSI weekly** | `rsi(close, 14)` on weekly bars | |
| **Daily SMA 50 / 200** | `sma(close, 50)`, `sma(close, 200)` on daily bars | Position reported as `100 × (close / sma − 1)`. |
| **Weekly 21 EMA** | `ema(close, 21)` on weekly bars | |
| **Weekly 30W / 200W SMA** | `sma(close, 30)`, `sma(close, 200)` on weekly bars | |
| **% off all-time high** | `100 × (close / max(high over stored history) − 1)` | **Intraday highs, not closes.** Split-adjusted, NOT dividend-adjusted — see §Basis. **Bounded by what we store:** the provider's plan carries 5 years (2 years before 2026-09-13), so for a name whose peak predates that (INTC, QCOM and GE all peaked in 2000) this understates the true all-time figure. The paid upgrade moved the bound; it did not remove it. The column is labelled with the window it actually covers rather than claiming "all time". Decision 0019; a one-time deep backfill is the fix and is not built yet. |
| **% above all-time low** | `100 × (close / min(low over stored history) − 1)` | Intraday lows. Same stored-window bound as the high above. |
| **% off 52-week high** | `100 × (close / max(high over last 252 trading bars) − 1)` | **252 trading bars, not 52 calendar weeks.** Intraday highs. |
| **Realized volatility** | `stdev_sample(r, 20) × √252 × 100` where `r[t] = ln(close[t] / close[t−1])` | **Our definition — TradingView has no canonical equivalent.** Log returns; sample standard deviation (n−1 denominator); 252-day annualisation; 20-bar window. |
| **Volume ratio** | `volume[t] / sma(volume, 50)[t]` | The 50-bar average **includes** the current bar. |

### Weekly bar construction

Every weekly parameter depends on this, so it is pinned explicitly:

- **Week starts Monday** (ISO week).
- `open` = first daily open of the week; `high` = max daily high; `low` = min daily low; `close` = last daily close; `volume` = sum.
- The **current partial week is stored** but rules and the dashboard read the **last completed week**, so no backtest can see the remainder of a week it is standing in.
- **"Completed" is defined negatively, and deliberately: a week is complete when it is not the most recent week for that symbol.** We have no market calendar, so we cannot know a week has *ended*; what we do know is that only the newest week can still gain bars. That definition needs no calendar, is per-symbol (a name that stopped trading does not make every other name's latest week look finished), and handles holidays for free — **a holiday-shortened week is a normal week with fewer bars, not a gap.** The published `bars_in_week` lets a reader see a short week; `is_complete` is the flag readers filter on. The tempting wrong definition is `bars_in_week = 5`, which would silently drop every holiday week, and `scripts/verify_parameters.sql` has a check whose only job is to fail the day someone writes it.

### How a weekly value attaches to a day

The grid is keyed on days; weekly parameters are keyed on weeks. The join is pinned here because it
is where a backtest gets silently corrupted:

> **The weekly value shown on day *d* is the newest week that started strictly before the week
> containing d** — `week_start < date_trunc('week', d)`.

- **It cannot see the future.** Any week earlier than d's own week had certainly finished by d; d's
  own week had not, and is excluded by construction. Hard constraint 5, as arithmetic.
- **It does not consult `is_complete`.** That flag describes the data *as it stands now*, so a
  reader standing on a past date would be asking a question only the present can answer. The date
  comparison gives the same answer whenever it runs, which is what keeps a parameter a pure function
  of (ticker, date).
- **Weekly columns are therefore constant Monday to Friday** and step once, on the week boundary. A
  weekly cell that changes mid-week is a bug, not a move.

Decision 0032; asserted in `scripts/ci/check_formulas.sql` under the `as-of` section.

### Relative

| Parameter | Definition |
|---|---|
| **Relative strength vs SPX** | `(close[t]/close[t−n] − 1) − (index[t]/index[t−n] − 1)`, for n ∈ {63, 126, 252} **trading bars** — not calendar months. Reported as percentage points of out/under-performance. SPX comes from FRED `SP500`, a price index (no dividends), which is the right comparison for a price-basis stock series. **Each leg counts bars in its own series** (`lag(close, n)` over its own partition) and the two are joined on an **exact date**, so both windows end on the same session — an as-of join on either leg would compare two different windows. Verified 2026-09-15: across the 1,236 dates held, SPX is missing exactly one, and that one is the FRED publication lag rather than a calendar difference. Columns are named by bars (`rs_63b`, `rs_126b`, `rs_252b`); the legacy norm `rs_vs_spx_6m` was renamed to `rs_vs_spx_126b` on 2026-09-16 rather than matched to, closing the mismatch 0035 left open. **A value equal to a norm bound is INSIDE the band** (`<` and `>`, not `<=`/`>=`) — asserted since 2026-09-16 by a CI norm whose bound is an exact fixture value, because until then no cell anywhere sat on a boundary and the two spellings were indistinguishable to every check. Decisions 0035, 0037, 0039. |
| ~~Relative strength vs SOX~~ | **Dropped in v1 (decision 0019).** No free data source carries the PHLX Semiconductor Index, and a proxy ETF would have meant reporting one thing while labelling it another. Restore the parameter and the `rs_vs_sox_6m` norm together if index data is ever paid for. |
| **Sector-relative valuation rank** | Percentile rank of the name's FCF yield within its theme group, computed across the group on the same date. |
| **Sector-relative margin rank** | Same, on trailing-twelve-month gross margin. |

### Market

| Parameter | Definition |
|---|---|
| **VIX level** | `^VIX` close. |
| **VIX regime band** | Fixed bands, not percentiles: `< 16` / `16–30` / `30–50` / `50–80` / `> 80`. |
| **VIX term structure** | `VIX3M / VIX − 1`, as a percentage. Positive = contango (normal), negative = backwardation (stress priced as persistent). |
| **Watchlist breadth** | Share of active **company** tickers — non-index **and non-fund** — whose close is above their own daily SMA(200), as a percentage. An ETF is a basket of names already counted, so including one would weight them twice by an amount that depends on fund composition we do not track (decision 0041); `breadth_tracked` publishes the universe size, 43 rather than the 53 rows on the grid. Names without 200 bars are excluded from both numerator and denominator. **Null, not 0%, when nobody is eligible** — 199 of 1,236 stored dates, all early history. `breadth_eligible` is published alongside, because 0% of 2 names and 0% of 36 are different facts. |

### How the market block is dated

FRED publishes later than the evening ingest, so on the date the grid is built there is often no
index bar for it yet (decision 0033). Each series is therefore taken **as of** the date — the newest
observation on or before it — and `market_context` publishes `vix_as_of`, `vix3m_as_of` and
`spx_as_of` next to the values.

- `vix_as_of < d` is an honest report of a known lag, not an error.
- **Term structure is null unless `vix3m_as_of = vix_as_of`.** A ratio of two series taken at
  different moments is a different quantity, not a stale one. 33 of 2,785 stored VIX days have no
  VIX3M observation and therefore no term structure.
- Anything reading the market block takes its currency from these dates, never from `d`.

Decision 0034; asserted in `scripts/ci/check_formulas.sql` under the `market` section.

---

## 4. Warm-up requirements

A recursive indicator's seed decays as `(1−α)^bars`. Below the bar counts here, the reported value still carries measurable seed influence and should be **suppressed rather than shown**.

| Indicator | α | Bars until seed influence < 0.01% |
|---|---|---|
| RMA(14) — drives all RSI | 0.071429 | **125** |
| EMA(21) | 0.090909 | **97** |
| EMA(50) | 0.039216 | 231 |
| EMA(200) | 0.009950 | 922 |

SMAs have no seed and are simply null until the window fills.

**These floors are counts of bars, not of days.** A bar is whatever the timeframe says it is, so the same 125 and 97 apply to weekly series — which is why they bite there and not on daily: 125 weeks is nearly two and a half years of history.

**Live consequence on the current watchlist.** Every name clears the daily thresholds.

Weekly bar counts depend entirely on the data plan, so they are stamped with it. **Any figure here without a plan and a date attached should be distrusted** — this paragraph has now been wrong twice in one day for exactly that reason.

| Measured | Plan | Weekly bars available | Names with 200+ weekly bars |
|---|---|---|---|
| 2026-09-13, before the re-backfill | Polygon free, 2 years | **103 maximum**, for every name | **0 of 36** |
| 2026-09-13, after the re-backfill | Polygon Stocks Starter, 5 years | ~256 for a name listed throughout | **33 of 36** |

So the **200-week SMA is computable** as of the re-backfill. The three names short of it are short for a real reason, not a data gap: **ARM** (listed 2023-09-14, ~156 weekly bars), **ALAB** (2024-03-20, ~129) and **SNDK** (2025-02-24, ~81). SNDK is also the only name that fails the 97-bar seed floor for the weekly 21 EMA, and will until roughly March 2027.

A note on a correction that was itself corrected: this line originally quoted ALAB at 129 and ARM at 156 from the deep Yahoo prototype. Mid-day it was "corrected" to say the ceiling was 103 for every name — true at that moment, on two years of history. The re-backfill made the original figures right again. The lesson is not that either number was careless; it is that a bar count is a fact about a **subscription**, not about a company, and writing it down without the plan attached guarantees it goes stale invisibly.

---

### How warm-up is enforced in the implementation

Two different questions hide under the word "warm-up", and `daily_features` answers them
differently on purpose.

| Question | Threshold | What the view does |
|---|---|---|
| **Does the window exist at all?** | 15 bars for RSI(14), 21 for EMA(21), 50 and 200 for the SMAs | The column is `NULL`. There is no value to report. |
| **Has the seed decayed?** | the table above — **125** bars for RMA(14), **97** for EMA(21) | The value **is** published, and `rsi_daily_seed_ok` / `ema21_seed_ok` is `false`. |

The split matters because the two thresholds are different kinds of thing. The first is a
definition: a 30-bar average is not an SMA(50). The second is a display judgment: the number is
computed correctly, it just still remembers where it started, so a cell should not be coloured on
it (hard constraint 8). Nulling it in the view would throw away a value a backtest may
legitimately want, and a null cannot be un-nulled.

What is *not* a display judgment is the floor itself. It appears in exactly two places — the table
above, and two named constants in `supabase/migrations/20260913064000_daily_features.sql` — and
`scripts/verify_parameters.sql` asserts that the flags agree with those numbers. So a floor that
changes in one place fails a check instead of drifting into the grid, the digest and the rule
engine as three different numbers.

**One thing this does not cover:** RSI is null, legitimately, on a genuinely flat 14-bar stretch —
zero average gain *and* zero average loss, where RSI is undefined. That is why the verify script
checks "RSI never present before bar 15" but not "RSI always present after bar 15". A halted or
illiquid name is not a bug.


## 4a. Basis — which price series everything is computed on

**Every price in this system is split-adjusted and NOT dividend-adjusted.** That is one
sentence with a lot riding on it, so: a 2-for-1 split halves the historical prices, and a
dividend payment does not touch them.

Why this basis and not another:

- It is **TradingView's default**, and TradingView is our anchor (§1). Dividend adjustment is
  an opt-in setting there, off unless a user turns it on.
- It is what the golden values in §6 were computed on. Those came from Yahoo's `close` column,
  which is split-adjusted only; Polygon's `adjusted=true` is also split-adjusted only
  ("adjusted for splits, but not dividends", vendor knowledge base, verified 2026-09-13). The
  provider changed in decision 0019 and the basis did not, so the verified figures still hold.
- It keeps `close` and `high` on the **same** basis, which is what makes "% off the high"
  meaningful. Mixing a dividend-adjusted history against a raw close would quietly overstate
  every drawdown on a dividend payer.

Consequence to be honest about: for a high-yield name held over years, a dividend-adjusted
total-return series would show a different — arguably fairer — drawdown. We are measuring price,
not total return, and the columns mean price. The `adj_close` column exists in `daily_bars` for
a provider that supplies a dividend-adjusted series, and is **null** today. Nothing reads it,
and nothing may fill it from `close`.

## 5. Where we knowingly differ from consumer apps

**Technicals: we match TradingView.** The formulas above are theirs, and so is the price basis
(§4a) — split-adjusted, dividends not.

**Fundamentals: we cannot match, and should not pretend to.** Robinhood and similar apps buy adjusted vendor data; we compute from GAAP filings via SEC XBRL. Our trailing P/E will differ from theirs whenever they use non-GAAP earnings, and no amount of care closes that gap. The column carries a note saying so.

**Robinhood and TradingView also disagree with each other**, so "match the app" was never a single target.

---

## 6. Verification

Each indicator was computed two independent ways and compared. The SQL implementation runs over the full history (2,529 daily / 525 weekly bars); the Python reference implements TradingView's formulas directly over a shorter window with SMA seeding. Agreement across *different windows and different seeding* is a stronger result than agreement between two runs of the same code.

Micron, as of the 2026-09-04 close:

| Indicator | Python (TradingView-exact) | SQL (production) | Difference |
|---|---|---|---|
| Daily EMA(21) | 943.558105 | 943.558106 | 1×10⁻⁶ |
| Daily SMA(50) | 938.279600 | 938.279603 | 3×10⁻⁶ |
| Daily SMA(200) | 606.479549 | 606.479551 | 2×10⁻⁶ |
| Weekly RSI(14) | 63.562709 | 63.562711 | 2×10⁻⁶ |
| Weekly EMA(21) | 839.355683 | 839.355685 | 2×10⁻⁶ |

Residuals are float64 accumulation over hundreds of recursive steps, not logic differences.

A third implementation — pandas `ewm(alpha=1/14, adjust=False)`, a completely different code path — reproduced the Wilder RSI to **exactly zero difference**.

**Invariants checked:** RSI within 0–100 across the series; SMA(200) lies between the min and max of its own window; realized volatility non-negative; EMA(21) closer to the latest price than SMA(50) in a trend.

### Cross-provider re-verification, 2026-09-13

The provider changed from Yahoo to Polygon (decision 0019). Rather than assume the figures above
survived, they were recomputed **in production SQL, from Polygon data**, for the same date:

| Indicator | From Polygon | Golden (from Yahoo, 2026-09-05) | Difference |
|---|---|---|---|
| RSI(14) daily, Wilder | 60.146703 | 60.146789 | −8.6×10⁻⁵ |
| EMA(21) daily | 943.557960 | 943.558105 | −1.45×10⁻⁴ |
| SMA(50) daily | 938.279500 | 938.279600 | −1.0×10⁻⁴ |
| SMA(200) daily | 606.479525 | 606.479549 | −2.4×10⁻⁵ |

All four inside 1.5×10⁻⁴, same sign and magnitude — consistent with sub-cent differences in the
vendors' reported closes, not a difference in method or basis. Independently, Polygon's maximum
high for MU is **1255**, matching the $1,255.00 all-time high measured from Yahoo on 2026-09-05.

Two things this establishes beyond "the numbers still work":

1. **The basis is genuinely the same.** Both vendors report split-adjusted, dividend-unadjusted
   prices (§4a). That was the claim that justified the provider swap; it is now measured rather
   than asserted.
2. **The warm-up floors in CONSTRAINTS.md are real.** The golden RSI came from a 2,529-bar
   history; this one from 490 bars, so the Wilder seed started at a completely different point
   and still converged to the same value. Past the 125-bar RMA floor the seed is gone, exactly as
   the table predicts. Same for EMA(21) past its 97-bar floor.

### Standing checks

- **What CI gates, and what it cannot.** Since 2026-09-13 a CI job applies every migration to a
  fresh PostgreSQL, loads a synthetic series, and asserts our SQL matches an independent
  implementation of these definitions to 1e-9 — RSI, EMA and SMA currently agree at exactly zero.
  That gates the **formulas**. It cannot gate the **golden values below**, because reproducing them
  needs a real price series and the data plan is licensed for individual use, so one cannot be
  committed to a public repo. The goldens therefore remain a manual check against production, and
  the split is structural rather than temporary: CI proves we compute what we said; the goldens
  prove the vendor's data and adjustment basis still match TradingView. Decision 0029.
- **Golden values.** **Scripted, and gated only in part — see above.** `scripts/verify_parameters.sql` asserts all
  six figures above, plus MU's peak intraday high as of the same date, at 1e-3 absolute
  tolerance — chosen because observed cross-provider agreement is 2.4×10⁻⁵ to 1.5×10⁻⁴ while the
  error it exists to catch (a plain rolling mean instead of Wilder's) is 9.4 RSI *points* wide.
  A human still has to run it and read the result; nothing fails a build yet.

  **The residual difference is a floor, not convergence error.** Re-verified 2026-09-13 after the
  history behind each value went from 494 bars to 1235: the diffs did not move at all — RSI stayed
  at 8.634×10⁻⁵ and EMA(21) at 1.452×10⁻⁴, byte for byte. The reason is that Wilder's seed had
  already decayed to about 4×10⁻¹⁶ by 494 bars, far below float64 resolution, so there was nothing
  left to converge. What remains is the genuine difference between the vendor the goldens came from
  (Yahoo) and the one we use now (Polygon), plus rounding in a hand-read TradingView figure. **More
  history will never shrink it**, so do not treat a future non-shrinking diff as a failure to
  improve — and do not tighten the tolerance below it expecting the numbers to catch up. Progress on the
  2026-09-13 position, not a substitute for CI. The script reports `MISSING` rather than `PASS`
  when the row it needs is absent, which is the whole point — a check that silently verifies zero
  rows is the "successful operation that changed nothing" bug wearing a green tick.
  **The two weekly goldens are pinned to a WEEK, at the same 1e-3, and that last part is a
  correction.** They sit on MU's week of **2026-08-31** — Monday 08-31 to Friday 09-04, so its close
  *is* the 2026-09-04 close the four daily goldens use: one hand-reading, both timeframes. The plan
  recorded against task #45 said the weekly tolerance would have to be *derived* and looser, because
  a weekly series carries ~1/5 the bars and therefore a heavier seed residual. Re-measured on the
  5-year backfill (257 weekly bars): residual seed weight is **1.75×10⁻⁸** for RMA(14) and
  **1.87×10⁻¹⁰** for EMA(21), and SQL agrees with the Python reference to 5.0×10⁻⁸ and 9.9×10⁻⁸ —
  five orders of margin inside 1e-3. The plan was right for the 102 weekly bars we held when it was
  written; the backfill, not an error, is what invalidated it. `sma30w` and `sma200w` are
  deliberately **not** goldens: no hand-read TradingView figure exists for either, so pinning our own
  output would assert only that we agree with ourselves. They are covered at 1e-9 against an
  independent implementation in CI instead. A golden read against a week flagged incomplete reports
  a distinct failure message, because that is a rollup or data-end-date problem, not a formula one.
- **Formula-level verification against an independent reference, 2026-09-13.** The
  `daily_features` SQL was run against a synthetic 300-bar series in a throwaway PostgreSQL 16
  instance and compared column by column with a Python implementation written from these
  definitions: **1,798 values, worst relative error 3.9×10⁻¹⁶, zero null-placement mismatches.**
  Degenerate series were included deliberately — flat (RSI undefined → null), monotonically rising
  (RSI exactly 100), monotonically falling (RSI exactly 0), a 10-bar series below every window,
  and a close-only series shaped like a FRED index (every high/low/volume column null). This is
  the check that proves the *formulas*; the golden values prove the *basis and the data*. Neither
  substitutes for the other.
- **The weekly layer got the same treatment, 2026-09-13.** `weekly_features` is compared against
  independently computed weekly expectations from the same synthetic series (`ci_expected_weekly`)
  at 1e-9, and three structural claims about the rollup are asserted rather than assumed: every
  daily bar lands in exactly one week, each weekly close equals the **last** daily close of its week
  (not Friday's — the classic rollup bug, and in a holiday week it reads a bar that does not exist),
  and exactly one week per symbol is incomplete. Those three are the errors that a formula check
  cannot see, because a wrong rollup feeds a correct formula.
- **Cross-implementation.** Three implementations have now agreed: the Python reference,
  production SQL over Yahoo data, and production SQL over Polygon data.
- **Invariants.** Now in `scripts/verify_parameters.sql` as 21 checks — impossible bars, future
  dates, RSI range, non-negative volatility, close never outside the running extremes (which is
  what catches a `range` window frame where `rows` was meant), exact warm-up placement in both
  directions, seed flags against the floors, per-symbol coverage, and matview freshness. Every one
  is phrased as "count the rows that violate this", so the expected answer is always zero and a
  new violation cannot hide inside an average. Still run by a human.

---

## 7. Fundamentals — settled

Settled 2026-09-16, decision 0040. **Nothing here is built yet**; this is the contract the
implementation has to meet, written before the code so the code cannot quietly decide it.

**The principle that decides most of them** is §5 above: *we compute from GAAP filings via SEC XBRL,
and we cannot match a consumer app that buys adjusted vendor data.* Wherever the choice was "the
number Robinhood shows" against "the number the filing supports", **the filing wins and the column
carries the divergence**. That settled four of the seven on its own.

**The second principle is hard constraint 4:** SEC XBRL is stamped with filing dates and is therefore
genuinely point-in-time. Using restated figures, or a vendor's cleaned series, throws that away and
with it the backtesting property decision 0002 exists to protect.

| Parameter | Definition | Null when |
|---|---|---|
| **Trailing P/E** | `price / Σ(last four quarters' diluted EPS)`. **GAAP, diluted.** | TTM EPS ≤ 0 — see below |
| **Net debt / EBITDA** | `net debt / TTM EBITDA`, where `EBITDA = OperatingIncomeLoss + DepreciationDepletionAndAmortization` and `net debt = short-term debt + long-term debt + operating lease liabilities − cash and equivalents − short-term investments` | EBITDA ≤ 0 |
| **ROIC** | `NOPAT / (total debt + total equity − cash)`, where `NOPAT = OperatingIncomeLoss × (1 − effective tax rate)` and the effective rate is `IncomeTaxExpenseBenefit / pre-tax income`, **clamped** | pre-tax income ≤ 0, or invested capital ≤ 0 |
| **FCF yield** | `(CFO − capex) / market cap`, where `capex = payments to acquire PP&E + capitalised software` | market cap unavailable |
| **EV / Sales** | `EV / TTM revenue`, where `EV = market cap + total debt (leases included) − cash − short-term investments` | revenue = 0 |
| **Revenue growth** | **Quarterly** revenue, year-over-year, **as reported**. `rev_acceleration` is the change in that growth rate. | no year-ago quarter filed |
| **Share count change** | Year-over-year % change in `dei:EntityCommonStockSharesOutstanding` — the **cover-page** count. Negative is buyback, positive is dilution. | no year-ago filing |

### The four choices that were genuinely open, and what was chosen

**Diluted, not basic, EPS.** Diluted is a required GAAP line, it is the conservative reading, and it
is what "earnings per share" means without qualification. Basic flatters any company with meaningful
stock compensation, which is most of this watchlist.

**A negative P/E is null, not a small number.** A negative P/E is not cheap, it is meaningless, and in
a sorted column it would rank as the cheapest thing on the grid. A `pe_applicable = false` flag ships
beside it so a blank reads as *loss-making* rather than *missing data* — the same distinction
decision 0031 is about. **Null ≠ zero ≠ undefined**, again.

**Operating leases count as debt — in BOTH the leverage ratio and EV.** Post-ASC 842 they are on the
balance sheet and contractually owed, and rating agencies treat them as debt. Excluding them
understates obligations most for exactly the names where leverage matters — leased fabs, leased data
centres. The cost is that our leverage reads higher than the pre-2019 convention most screeners still
use, which §5 already says is the expected state. **There is no defensible way to count leases as debt
in one ratio and not the other**, so the two move together by construction, not by convention.

**Capex includes capitalised software.** PP&E alone overstates free cash flow for MSFT, GOOGL, META and
AMZN, who capitalise meaningful software — a large slice of this watchlist. The column reports **which
components were found** rather than silently summing whatever happens to exist, because the software
tag is not filed by everyone.

**Quarterly YoY revenue growth, not TTM.** It updates four times a year instead of being smeared
across four, and it is close to forced: `rev_acceleration` already has a norm, acceleration is the
change in the growth rate, and a TTM series smooths out exactly the signal it exists to show. TTM can
become a second column later if quarterly proves noisy.

### The two that were not really forks

**ROIC uses the simple construction** — `NOPAT / (debt + equity − cash)`. There are at least five
accepted definitions of invested capital; capitalising R&D, adjusting for goodwill and using average
rather than ending capital each have a real argument and each add a step that has to be explained
forever. Pick the recognisable one, state it on the column, and note that ROIC is definition-sensitive.

**EBITDA is `OperatingIncomeLoss + D&A`**, not `NetIncome + Interest + Taxes + D&A`. The literal
expansion of the acronym drags in investment gains and one-off charges, which make a leverage ratio
jump for reasons that have nothing to do with leverage.

### Analyst target gap is NOT here, and is not an SEC fundamental

It was the eighth row of this table. It is not a GAAP concept, not in XBRL, and not in FRED — **no
source in our data plane carries it.** PROPOSAL §"Valuation" already classes it as a **searched
column**, collected by web search rather than computed, and that is where it belongs; listing it
beside seven SEC-derived parameters implied a symmetry that does not exist.

The stronger objection is not cost. Every other number on this grid is a fact about a company or its
price. A consensus target is a fact about **what a group of analysts said** — the only column whose
meaning depends on someone else's judgment, in a product that is explicitly *a tracker, not an
advisor*. **Deferred to a later version** (Bodhi, 2026-09-16), as a searched column with its own
freshness rule, not as a fundamental.

### Before any of this is implemented — two things to measure, not assume

1. **Whether all 36 filers report these tags consistently**, and in which years. Tag availability
   varies by filer; a fundamental that silently goes null for six of the watchlist is worse than one
   that was never built. **`scripts/probe_sec_tags.sql` asks SEC directly** — paste it into the SQL
   editor a STEP at a time. It runs on a six-name sample first and prints the payload sizes, because
   pulling 36 `companyfacts` documents into `net._http_response` unmeasured is how a small instance
   fills up.

   Three things it expects to find, **written down before it was run so the result can contradict
   them**: that TSM, ASML and ARM report no `us-gaap` facts at all (foreign private issuers filing
   20-F under IFRS — 8% of the watchlist, and the foundry and lithography core of it); that the
   capitalised-software tag differs by filer, which is why §7 #4 names no tag; and that SNDK lacks
   four quarters of history. **None of these is a finding yet.**
2. **The effective-tax-rate clamp band in ROIC.** Several of these names have had quarters with tax
   benefits, where an unclamped rate goes negative and flips NOPAT's sign. **The band is deliberately
   not written above**, because a sensible one needs looking at real filings and a number invented
   here would be obeyed forever. Until it is measured from filings, this definition is incomplete and
   ROIC is not implementable.
