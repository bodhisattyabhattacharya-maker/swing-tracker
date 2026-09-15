-- 20260915130000_market_context.sql
-- Purpose:    the market block - VIX level and regime band, VIX term structure, S&P 500 close, and
--             watchlist breadth. One row per trading date, with the as-of date of every borrowed
--             value published beside it.
-- Depends on: daily_bars (^VIX, ^VIX3M, ^GSPC from FRED), daily_features (breadth), tickers,
--             index_status (20260915120000).
-- Grants:     select on market_context to service_role.
-- Reversing:  drop view public.market_context; nothing else is touched.
--
-- ---------------------------------------------------------------------------
-- A PLAIN VIEW, NOT A MATERIALIZED ONE, and that is a change of habit worth explaining.
--
-- Every other derived layer here is a matview because it is expensive per row and read per symbol.
-- This is one row per date over ~1,200 dates, and - crucially - its inputs refresh on TWO different
-- clocks: equities at 22:30 and the FRED index series at 11:00 the next morning (decision 0033). A
-- matview would be correct only between those two moments and silently wrong the rest of the time,
-- or would need adding to both jobs. A view is always current and needs no refresh entry, which is
-- one fewer thing to forget in the migration that adds the next matview.
--
-- THE AS-OF PROBLEM, and why every borrowed value carries its own date.
--
-- FRED publishes later than the evening ingest, so on the date the grid was built there is often no
-- index bar for that date yet. Rather than leave the whole market block null - which would blank it
-- every evening and refill it every morning, looking like a fault - each series is taken AS OF the
-- date: the newest index bar on or before d. The date that value actually came from is published
-- next to it.
--
-- So `vix_as_of < d` is not an error, it is the honest report of a known lag, and a reader (or a
-- page) can decide what to do about it. What is NOT acceptable is showing "VIX 16" under today's
-- date when the number is from Friday, which is what a silent join would do.
--
-- NULL IS NOT ZERO, in three places here, and each one was measured before being written:
--   * term_structure   33 of 2,785 VIX days have no ^VIX3M observation. Those days report null,
--                      not 0 - and 0 would read as "flat term structure", a real and different
--                      market state. It is also null whenever the two series' as-of dates differ:
--                      a ratio across two different moments is a different quantity, not a stale
--                      one. See the guard at the column itself.
--   * breadth_pct      199 of 1,236 dates have NOBODY eligible: early history, before any name has
--                      200 daily bars. Dividing by zero eligible names must yield null, not 0%,
--                      which would read as "every name below its 200 SMA" - the single most bearish
--                      reading the field can take.
--   * spx_close        the licensed FRED window starts 2016-09-12, so anything earlier is null.
--
-- `breadth_eligible` is published beside the percentage for the same reason: a breadth of 0% across
-- 2 eligible names and 0% across 36 are different facts, and only one of them is information.
-- ---------------------------------------------------------------------------

create view public.market_context as
with dates as (
  -- The grid's dates, not the index series' - this block describes the days we actually track.
  select distinct d from public.daily_features
),
breadth as (
  select
    f.d,
    count(*)                                                            as tracked,
    count(*) filter (where f.sma200 is not null)                        as eligible,
    count(*) filter (where f.sma200 is not null and f.close > f.sma200) as above
  from public.daily_features f
  join public.tickers t on t.symbol = f.symbol
  where t.active and not t.is_index
  group by f.d
)
select
  dates.d,

  -- ---- VIX, as of d -------------------------------------------------------
  vix.close                                                             as vix,
  vix.d                                                                 as vix_as_of,
  -- Fixed bands, NOT percentiles (DEFINITIONS §Market). A percentile band would call 16 "high" in a
  -- calm decade and "low" in a violent one; the whole point of a regime label is that it means the
  -- same thing in every year. Exhaustive and disjoint by construction - asserted in
  -- scripts/verify_parameters.sql rather than trusted.
  case
    when vix.close is null   then null
    when vix.close < 16      then '<16'
    when vix.close < 30      then '16-30'
    when vix.close < 50      then '30-50'
    when vix.close < 80      then '50-80'
    else                          '>80'
  end                                                                   as vix_band,

  -- ---- Term structure -----------------------------------------------------
  vix3m.close                                                           as vix3m,
  vix3m.d                                                               as vix3m_as_of,
  -- VIX3M / VIX - 1, as a percentage. Positive = contango (normal); negative = backwardation, the
  -- market pricing stress as persistent rather than a spike. Measured over 2,785 days: median
  -- +14.3%, range -25.6% to +35.9%, and 202 days (7.3%) in backwardation - rare enough to be worth
  -- seeing, common enough to be real.
  --
  -- Guarded on vix > 0 rather than merely not-null: the VIX cannot be zero, but a division that
  -- assumes it produces +infinity rather than an error, and an infinity in a percentage column is
  -- the kind of thing that renders as a blank and gets ignored.
  --
  -- AND GUARDED ON THE TWO AS-OF DATES MATCHING, which is the subtle one. Both series are taken
  -- as-of independently, so on a date where ^VIX3M has no observation the as-of join happily
  -- supplies an older one - and the ratio would then divide today's VIX by last Tuesday's VIX3M and
  -- report the result as a clean percentage. A term structure is a statement about ONE MOMENT in
  -- the curve; two moments is not a worse reading of it, it is a different quantity wearing its
  -- name. Production has 33 such days in 2,785. Caught by the CI fixture, which drops ^VIX3M on a
  -- cycle for exactly this reason - the first version of this view returned a number on every one
  -- of those days.
  case when vix3m.close is not null and vix.close > 0 and vix3m.d = vix.d
       then 100.0 * (vix3m.close / vix.close - 1) end                   as term_structure,

  -- ---- S&P 500 ------------------------------------------------------------
  spx.close                                                             as spx_close,
  spx.d                                                                 as spx_as_of,

  -- ---- Breadth ------------------------------------------------------------
  case when breadth.eligible > 0
       then 100.0 * breadth.above / breadth.eligible end                as breadth_pct,
  breadth.eligible                                                      as breadth_eligible,
  breadth.tracked                                                       as breadth_tracked,

  -- ---- Honesty about the lag ---------------------------------------------
  -- One number a reader can act on: how far the oldest borrowed index value is behind this date,
  -- in TRADING days, so a weekend reads as 0. Zero means the market block describes this date; one
  -- means it describes the session before it, which is the normal state for a few hours each
  -- evening until the 11:00 UTC catch-up runs.
  (select count(*) from (
     select distinct b2.d from public.daily_bars b2
     join public.tickers t2 on t2.symbol = b2.symbol
     where t2.active and not t2.is_index
       and b2.d > least(coalesce(vix.d, dates.d), coalesce(spx.d, dates.d))
       and b2.d <= dates.d) gap)                                        as index_days_behind

from dates
join breadth on breadth.d = dates.d
-- As-of joins: the newest index bar ON OR BEFORE this date. `left join lateral` so a date with no
-- index history at all still produces a row with nulls rather than vanishing from the series.
left join lateral (
  select b.d, b.close from public.daily_bars b
  where b.symbol = '^VIX' and b.d <= dates.d order by b.d desc limit 1
) vix on true
left join lateral (
  select b.d, b.close from public.daily_bars b
  where b.symbol = '^VIX3M' and b.d <= dates.d order by b.d desc limit 1
) vix3m on true
left join lateral (
  select b.d, b.close from public.daily_bars b
  where b.symbol = '^GSPC' and b.d <= dates.d order by b.d desc limit 1
) spx on true;

comment on view public.market_context is
  'One row per tracked date: VIX level and fixed regime band, VIX term structure, S&P 500 close and '
  'watchlist breadth. Every borrowed index value carries the date it actually came from, because '
  'FRED publishes later than the evening ingest and a market block silently showing Friday''s VIX '
  'under today''s date is worse than one that says so. null means unknown, never zero - see the '
  'header of 20260915130000 for the three places that matters and the counts behind each.';

grant select on public.market_context to service_role;
