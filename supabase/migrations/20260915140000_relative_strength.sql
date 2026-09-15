-- 20260915140000_relative_strength.sql
-- Purpose:    relative strength against the S&P 500 at 63, 126 and 252 trading bars.
-- Depends on: daily_bars (equities + ^GSPC from FRED), tickers.
-- Grants:     select on relative_strength to service_role.
-- Reversing:  drop view public.relative_strength; nothing else is touched.
--
-- ---------------------------------------------------------------------------
-- BARS, NOT MONTHS, AND EACH SERIES COUNTS ITS OWN
--
--   rs_n = (close[t]/close[t-n] - 1) - (spx[t]/spx[t-n] - 1),  in percentage points
--
-- `lag(close, n)` over each series' own partition is precisely "n bars back in THIS series". A
-- calendar interval would be a different quantity: `d - interval '63 days'` spans about 43 trading
-- days, and lands on a weekend or a holiday roughly a third of the time, at which point it silently
-- picks a neighbouring row or none at all.
--
-- MEASURED BEFORE WRITING (2026-09-15): the equities and ^GSPC share a trading calendar almost
-- exactly - across the 1,236 dates we hold, SPX is missing exactly ONE, and that one is
-- 2026-09-14, the FRED publication lag rather than a calendar difference. So "n bars back" means
-- the same window on both legs, which is the assumption the subtraction rests on and is worth
-- having checked rather than assumed.
--
-- ---------------------------------------------------------------------------
-- WHY THERE IS NO AS-OF LAYER IN HERE, WHICH IS A DEPARTURE FROM market_context
--
-- The obvious next step would be to carry each symbol's newest RS forward onto grid dates that SPX
-- has not reached yet, publishing an `rs_as_of` the way the market block does. It was written that
-- way first and then measured:
--
--     exact-date join, whole history      441 ms   (42,353 rows)
--     with a band join for the as-of      8,826 ms (the planner discards 51 MILLION candidate pairs)
--
-- Twenty times the cost to handle a single trailing date. The band join is cheap in `grid_cells`
-- (20 ms for one date) ONLY because a date predicate cuts the left side to 36 rows first; with no
-- filter it degenerates, and "the same query serves today's scan and a ten-year replay" is a stated
-- property of this project, so the unfiltered case is not hypothetical.
--
-- So this view publishes rows ON THE DATES THE COMPUTATION IS ACTUALLY VALID FOR - dates where both
-- legs have a bar - and nothing else. A reader wanting "the newest RS for this symbol" takes the
-- last row, which is an indexed lookup, and the date it carries IS the as-of date. The honesty is
-- the same; the cost is not.
--
-- The visible consequence: on the evening of a trading day there is no RS row for that date yet,
-- because SPX has not published. `public.index_status` says exactly that, and the 11:00 UTC
-- catch-up fills it in. A blank is the correct rendering of "not computable yet".
--
-- ---------------------------------------------------------------------------
-- WARM-UP NEEDS NO FLAG HERE, unlike the recursive indicators. RS is a ratio of two closes: with
-- fewer than n bars `lag` returns null and the value is null. There is no seed to decay, so nothing
-- is ever "computed but not yet trustworthy" - it either exists or it does not. rs_252 therefore
-- stays null for a name's first year, which is the honest answer and not a gap to fill.
--
-- A NAMING MISMATCH TO RESOLVE BEFORE THIS REACHES THE GRID: `config/norms.yml` carries a norm
-- called `rs_vs_spx_6m`, from before the bars-not-months decision. 126 bars is about six months but
-- is not six months, and a column named for one while computing the other is exactly the labelling
-- failure decision 0019 refused for ^SOX. The columns here are named by bars; the norm should be
-- renamed when the grid column lands, not quietly matched to.
-- ---------------------------------------------------------------------------

create view public.relative_strength as
with spx as (
  select
    d,
    close,
    lag(close, 63)  over w as c63,
    lag(close, 126) over w as c126,
    lag(close, 252) over w as c252
  from public.daily_bars
  where symbol = '^GSPC'
  window w as (order by d)
),
sym as (
  select
    b.symbol,
    b.d,
    b.close,
    lag(b.close, 63)  over w as c63,
    lag(b.close, 126) over w as c126,
    lag(b.close, 252) over w as c252
  from public.daily_bars b
  join public.tickers t on t.symbol = b.symbol
  where t.active and not t.is_index
  window w as (partition by b.symbol order by b.d)
)
select
  s.symbol,
  s.d,
  -- nullif(x, 0) on every denominator. A zero close is impossible in a price series and would be a
  -- data error, but division by it yields infinity rather than an error - and an infinity renders
  -- as a blank cell, which is indistinguishable from "not enough history" and would be read as one.
  100.0 * ((s.close / nullif(s.c63, 0)  - 1) - (x.close / nullif(x.c63, 0)  - 1)) as rs_63b,
  100.0 * ((s.close / nullif(s.c126, 0) - 1) - (x.close / nullif(x.c126, 0) - 1)) as rs_126b,
  100.0 * ((s.close / nullif(s.c252, 0) - 1) - (x.close / nullif(x.c252, 0) - 1)) as rs_252b
from sym s
-- EXACT date join, deliberately. Both legs must end on the same session or the subtraction compares
-- two different windows - the same defect as a term structure built from two as-of dates (0034).
join spx x on x.d = s.d;

comment on view public.relative_strength is
  'Relative strength vs the S&P 500 at 63, 126 and 252 TRADING BARS, in percentage points of '
  'out/under-performance. Each leg counts bars in its own series; the two are joined on an exact '
  'date so both windows end on the same session. Rows exist only on dates where both have a bar, so '
  'the newest trading day is absent until FRED publishes - see index_status. Null means not enough '
  'history, never zero. Decision 0035.';

grant select on public.relative_strength to service_role;
