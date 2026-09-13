-- 20260913064000_daily_features.sql
-- Purpose:    the first parameter layer. Turns raw daily bars into the daily technical
--             parameters: RSI(14), EMA(21), SMA(50/200) and positions, extremes, realised
--             volatility, volume ratio. One row per (symbol, trading date).
-- Depends on: daily_bars (20260912120000_foundation).
-- Used by:    scripts/verify_parameters.sql today; the dashboard grid and every future rule
--             later. No application code reads it yet.
-- Grants:     select to service_role only (decision 0018), and execute on the function to
--             service_role only - NOT to public. anon and authenticated get nothing until the
--             auth model is decided.
-- Reversing:  drop the matview, then the function. No source data is touched; everything here
--             is derived and rebuilds from daily_bars in seconds.
--
-- WHY EVERY DATE AND NOT JUST THE LATEST (decision 0002):
--   Parameters are a pure function of (ticker, date). Computing them across the whole history is
--   what makes a backtest a WHERE clause instead of a second implementation that drifts. ~39
--   symbols x ~494 dates is under 20k rows - "all of history" costs nothing here, and getting it
--   wrong later costs a parallel codebase.
--
-- WHY A MATERIALIZED VIEW:
--   The recursive indicators are O(n) per symbol and a plain view would recompute them on every
--   dashboard query. Materialised, a grid read is an index scan. The cost is that it MUST be
--   refreshed after each ingest, and nothing does that yet - until the scheduling PR lands,
--   treat the contents as stale and refresh by hand:
--       refresh materialized view public.daily_features;
--   The rejected alternative was having the ingest function compute and write these columns,
--   which would put the formulas in TypeScript where they could silently disagree with
--   DEFINITIONS.md. Keeping them in SQL next to the data keeps one definition.
--
-- THE TRAPS, each commented again at its site because this file is where they bite:
--   1. RSI uses WILDER smoothing (alpha = 1/n), not a rolling mean of gains and losses. Measured
--      gap on MU: 9.4 RSI points at today's date, and both are called "RSI" in the wild.
--   2. `rows between N preceding and current row`, never `range`. `range` widens the frame across
--      non-trading days and silently disagrees with TradingView.
--   3. Extremes use intraday high/low, never closes.
--   4. There are TWO different warm-up questions and this file answers them differently.
--      (a) "Does the window exist?" - 15 bars for RSI(14), 21 for EMA(21), 50 and 200 for the
--          SMAs. Below that there is no value to report, so the column is NULL.
--      (b) "Has the seed decayed?" - a recursive indicator keeps measurable seed influence far
--          past its window: 125 bars for RMA(14), 97 for EMA(21) (DEFINITIONS.md section 4).
--          Hard constraint 8 says suppress those rather than show them. This view does NOT null
--          them, because a backtest may legitimately want the converged-ish value and a null
--          cannot be un-nulled. Instead it publishes `rsi_daily_seed_ok` and `ema21_seed_ok`, so
--          suppression at the display layer is reading a boolean rather than re-deriving a floor
--          that would then exist in two places and drift.
--      The floors live in exactly one place: the two constants in this file, named after the
--      DEFINITIONS.md table they come from.

-- ---------------------------------------------------------------------------
-- The recursive indicators, one pass per symbol.
--
-- PL/pgSQL rather than a recursive CTE or a window-function closed form. The closed form for an
-- EMA requires dividing by (1-alpha)^i, which over 494 bars at alpha=1/14 reaches 7.7e15 and
-- bleeds exactly the precision the golden-value checks assert to 1e-6. A loop is exact, and it
-- puts Wilder's smoothing in one place a reader can check against DEFINITIONS.md section 1 line
-- by line.
--
-- `set search_path = ''` with fully-qualified names: an unqualified name in a function is
-- resolved with the CALLER's search_path, which the Supabase linter flags and which is a real
-- hijack risk on a function anyone can call. Every reference below is schema-qualified.
-- ---------------------------------------------------------------------------
create or replace function public.daily_recursive(p_symbol text)
returns table (
  d               date,
  rsi14           double precision,
  ema21           double precision,
  bars_available  integer
)
language plpgsql
stable
set search_path = ''
as $$
declare
  r          record;
  i          integer := 0;
  prev_close double precision;
  gain       double precision;
  loss       double precision;
  -- Wilder averages of gain and loss. alpha = 1/14, seeded with the SIMPLE mean of the first
  -- 14 changes, then smoothed (DEFINITIONS.md section 1, "RMA").
  sum_gain   double precision := 0;
  sum_loss   double precision := 0;
  avg_gain   double precision;
  avg_loss   double precision;
  alpha_rma  constant double precision := 1.0 / 14;
  -- EMA(21): alpha = 2/(n+1), seeded with the simple mean of the first 21 closes.
  sum_close  double precision := 0;
  ema        double precision;
  alpha_ema  constant double precision := 2.0 / 22;
  rs         double precision;
begin
  for r in
    select b.d as bar_d, b.close as bar_close
    from public.daily_bars b
    where b.symbol = p_symbol
    order by b.d
  loop
    i := i + 1;

    -- ---- Wilder RSI(14) ----
    -- 14 CHANGES, which means 15 bars. Bars 2..15 build the seed; bar 16 onward smooths.
    if prev_close is not null then
      gain := greatest(r.bar_close - prev_close, 0);
      loss := greatest(prev_close - r.bar_close, 0);

      if i <= 15 then
        sum_gain := sum_gain + gain;
        sum_loss := sum_loss + loss;
        if i = 15 then
          avg_gain := sum_gain / 14;
          avg_loss := sum_loss / 14;
        end if;
      else
        avg_gain := avg_gain + alpha_rma * (gain - avg_gain);
        avg_loss := avg_loss + alpha_rma * (loss - avg_loss);
      end if;
    end if;

    -- The degenerate cases are written out rather than left to divide by zero. All three are
    -- reachable on real data: a 14-bar run with no down day, with no up day, and (on an
    -- illiquid or halted name) with no movement at all.
    if avg_gain is null then
      rsi14 := null;                                     -- still warming up
    elsif avg_gain = 0 and avg_loss = 0 then
      rsi14 := null;                                     -- no movement: RSI is undefined, not 50
    elsif avg_loss = 0 then
      rsi14 := 100;
    elsif avg_gain = 0 then
      rsi14 := 0;
    else
      rs := avg_gain / avg_loss;
      rsi14 := 100 - 100 / (1 + rs);
    end if;

    -- ---- EMA(21) ----
    if i <= 21 then
      sum_close := sum_close + r.bar_close;
      if i = 21 then
        ema := sum_close / 21;
      end if;
    else
      ema := ema + alpha_ema * (r.bar_close - ema);
    end if;
    ema21 := ema;                                        -- null until bar 21, by design

    d := r.bar_d;
    bars_available := i;
    prev_close := r.bar_close;
    return next;
  end loop;
end;
$$;

comment on function public.daily_recursive(text) is
  'Wilder RSI(14) and EMA(21) for one symbol, one exact pass. See DEFINITIONS.md section 1.';

-- EXECUTE on a function is granted to PUBLIC by default, and `revoke ... from anon,
-- authenticated` does NOT remove it - anon inherits through PUBLIC. Revoking from public is the
-- only thing that works. Learned the hard way on 2026-09-13 (INCIDENTS.md), so it is done
-- explicitly here rather than assumed.
revoke execute on function public.daily_recursive(text) from public;
grant execute on function public.daily_recursive(text) to service_role;

-- ---------------------------------------------------------------------------
-- The daily parameter layer.
--
-- Non-recursive indicators use window functions with `rows`, never `range` - see trap 2.
--
-- INDEX SYMBOLS (^VIX, ^VIX3M, ^GSPC) come from FRED, which publishes a CLOSE only: no OHLC, no
-- volume. Every column below that reads high, low or volume is therefore null for them, which is
-- honest rather than broken. The market-context parameters that need an index's 52-week position
-- are close-based and arrive in the market-context PR; they are not silently faked here.
-- ---------------------------------------------------------------------------
create materialized view public.daily_features as
with rec as (
  -- One invocation per SYMBOL, not per row. Calling the function in the join condition of the
  -- bar-level query would invoke it once per (symbol, date) - 19k full-history scans instead of
  -- 39. LATERAL is implicit for a function in FROM, but it is spelled out to make the
  -- per-symbol shape obvious to the next reader.
  select s.symbol, f.d, f.rsi14, f.ema21, f.bars_available
  from (select distinct b.symbol from public.daily_bars b) s
  cross join lateral public.daily_recursive(s.symbol) f
),
base as (
  select
    b.symbol,
    b.d,
    b.close,
    b.volume,

    -- Param: daily SMA(50) and SMA(200). Null until the frame actually holds that many bars;
    -- a 30-bar "SMA(50)" is a different statistic wearing the same label.
    case when count(*) over w50  = 50  then avg(b.close) over w50  end as sma50,
    case when count(*) over w200 = 200 then avg(b.close) over w200 end as sma200,

    -- Param: % off all-time high, % above all-time low. INTRADAY extremes (trap 3), cumulative
    -- over everything stored SO FAR - the frame ends at the current row, so it can never see a
    -- future high.
    max(b.high) over cumulative as max_high_to_date,
    min(b.low)  over cumulative as min_low_to_date,

    -- Param: % off 52-week high. 252 TRADING bars, not 52 calendar weeks (DEFINITIONS.md).
    case when count(*) over w252 = 252 then max(b.high) over w252 end as high_252,

    -- Param: volume ratio. The 50-bar average INCLUDES the current bar, per DEFINITIONS.md -
    -- that is what the screener convention does, and excluding it would shift every value.
    case when count(b.volume) over w50 = 50
         then avg(b.volume::double precision) over w50 end as avg_volume_50,

    -- Log return, for realised volatility below. Null on the first bar of each symbol.
    case when lag(b.close) over by_date > 0
         then ln(b.close / lag(b.close) over by_date) end as log_ret
  from public.daily_bars b
  window
    by_date    as (partition by b.symbol order by b.d),
    cumulative as (partition by b.symbol order by b.d
                   rows between unbounded preceding and current row),
    w50  as (partition by b.symbol order by b.d rows between 49  preceding and current row),
    w200 as (partition by b.symbol order by b.d rows between 199 preceding and current row),
    w252 as (partition by b.symbol order by b.d rows between 251 preceding and current row)
),
vol as (
  select
    base.*,
    -- Param: realised volatility. Sample standard deviation (n-1) of 20 daily log returns,
    -- annualised by sqrt(252), expressed as a percent. This is OUR definition - there is no
    -- canonical one on TradingView - so it is stated here and in DEFINITIONS.md, and any change
    -- to the window or the annualisation factor changes every historical value.
    case when count(base.log_ret) over w20 = 20
         then stddev_samp(base.log_ret) over w20 * sqrt(252.0) * 100 end as realized_vol_20
  from base
  window w20 as (partition by base.symbol order by base.d
                 rows between 19 preceding and current row)
)
select
  v.symbol,
  v.d,
  v.close,
  -- How many bars of history stand behind this row.
  rec.bars_available,

  -- Recursive indicators, from the exact one-pass function above.
  rec.rsi14  as rsi_daily,
  rec.ema21  as ema21_daily,

  -- Seed-decay flags (trap 4b). The numbers are the "< 0.01% seed influence" bar counts from
  -- DEFINITIONS.md section 4 - 125 for RMA(14), 97 for EMA(21) - and they are written here and
  -- nowhere else. False means "computed, but still partly its own seed; do not colour a cell on
  -- it". Null-safe by construction: bars_available is never null.
  (rec.bars_available >= 125) as rsi_daily_seed_ok,
  (rec.bars_available >= 97)  as ema21_seed_ok,

  v.sma50,
  v.sma200,
  -- Positions are percentage distances, because that is what the grid colours against: a norm
  -- like "above the 200-day" is really "not more than x% below it".
  case when v.sma50    is not null then 100 * (v.close / v.sma50    - 1) end as close_vs_sma50d,
  case when v.sma200   is not null then 100 * (v.close / v.sma200   - 1) end as close_vs_sma200d,
  case when rec.ema21  is not null then 100 * (v.close / rec.ema21  - 1) end as close_vs_ema21d,

  v.max_high_to_date,
  v.min_low_to_date,
  -- Named "_stored", not "_ath": the free plan holds two years, and INTC, QCOM and GE peaked in
  -- 2000. The column name is the warning, so nobody reads a bounded number as an all-time one.
  case when v.max_high_to_date > 0
       then 100 * (v.close / v.max_high_to_date - 1) end as pct_off_high_stored,
  case when v.min_low_to_date > 0
       then 100 * (v.close / v.min_low_to_date  - 1) end as pct_above_low_stored,
  case when v.high_252 > 0
       then 100 * (v.close / v.high_252 - 1) end         as pct_off_52w_high,

  v.realized_vol_20,
  case when v.avg_volume_50 > 0
       then v.volume::double precision / v.avg_volume_50 end as volume_ratio
from vol v
join rec on rec.symbol = v.symbol and rec.d = v.d;

comment on materialized view public.daily_features is
  'Daily technical parameters per (symbol, date). Derived - rebuild with REFRESH MATERIALIZED '
  'VIEW public.daily_features. Extremes cover STORED history (2 years on the free plan), not '
  'all time. Index symbols have no OHLC or volume, so those columns are null for them. A '
  'recursive indicator whose *_seed_ok flag is false is still partly its own seed - suppress it '
  'rather than colour a cell on it (hard constraint 8). Formulas: DEFINITIONS.md sections 1-4.';

-- One row per symbol per date. The unique index is also what makes REFRESH ... CONCURRENTLY
-- possible later, so the dashboard never reads an empty view mid-rebuild.
create unique index daily_features_pk on public.daily_features (symbol, d);
-- The grid reads one date across all symbols; that scan should not be a seq scan on 20k rows.
create index daily_features_d_idx on public.daily_features (d);

-- Grants: explicit, per decision 0018. Read-only by nature - a matview is written by REFRESH,
-- run as its owner, never by a client. No insert/update/delete to grant, and no delete to
-- withhold.
grant select on public.daily_features to service_role;
