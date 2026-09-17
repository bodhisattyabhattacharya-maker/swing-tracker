-- 20260917060000_funds_and_universe.sql
-- Purpose:    make room for the universe the UI spec describes - 43 companies and 10 ETFs, up from
--             36 companies. Adds `tickers.is_fund` and takes funds out of watchlist breadth.
-- Depends on: tickers (20260912120000), market_context (20260915130000), daily_features.
-- Grants:     none new. `market_context` keeps its existing grant.
-- Reversing:  restore the breadth CTE of 20260915130000 and drop the column. No data is touched;
--             `is_fund` defaults false, so dropping it returns every row to its previous meaning.
--
-- ---------------------------------------------------------------------------
-- WHY A SECOND FLAG AND NOT A SECOND MEANING FOR `is_index`
--
-- The two exclusions look alike and are not:
--
--   is_index   CONTEXT. ^VIX, ^VIX3M, ^GSPC. Never a row on the grid, never ranked, never in
--              breadth. Its entire job is to be the thing other numbers are measured against.
--   is_fund    A ROW. SPY, QQQ, XLE and the rest trade, have OHLCV, have an RSI and a 200-day
--              average, and belong on the grid beside the names they contain. What a fund lacks
--              is an INCOME STATEMENT - so every fundamental is legitimately not-applicable
--              rather than missing, which the spec renders as a distinct state.
--
-- Overloading `is_index` would have been one line shorter and would have deleted ten rows from
-- the grid, silently, which is the whole feature.
--
-- ---------------------------------------------------------------------------
-- BREADTH EXCLUDES FUNDS, and this is the one behavioural change in this migration
--
-- Breadth is "how many of OUR NAMES are above their own 200-day average". An ETF is a basket of
-- those same names: SMH holds most of the semiconductor block, SPY and QQQ hold the mega-caps.
-- Counting them would weight names that are already counted, by an amount that depends on fund
-- composition we do not track - so the number would stop meaning what DEFINITIONS §Market says
-- it means, and would drift as those funds rebalance.
--
-- The published `breadth_tracked` therefore stays at the count of COMPANIES (43 after this lands,
-- not 53). That figure is read by anyone checking whether breadth covers what they think it does,
-- so it must move with the definition rather than with the row count of `tickers`.
-- ---------------------------------------------------------------------------

alter table public.tickers
  add column if not exists is_fund boolean not null default false;

comment on column public.tickers.is_fund is
  'An ETF: trades and charts like a stock, has no financial statements. NOT the same as is_index - '
  'a fund IS a grid row, an index never is. Set per-entry in config/watchlist.yml (`fund: true`), '
  'deliberately not derived from the theme, so a fund filed under another theme is still a fund. '
  'Excluded from watchlist breadth because a basket of our own names double-counts them.';

-- NOT CHANGED, deliberately: `index_days_behind` still counts trading dates across `not is_index`
-- WITHOUT the fund exclusion. It measures the CALENDAR - which dates the market was open - not the
-- universe, and funds trade the same sessions, so excluding them cannot change the answer while
-- narrowing it would make the query say something it does not mean.
--
-- THE VIEW BODY BELOW IS THE 20260915130000 BODY, byte-for-byte, with that one predicate edited.
-- It was produced by substitution rather than retyped: a first attempt at rewriting it from memory
-- got `index_days_behind` wrong - a trading-day subquery became a date subtraction - which would
-- have silently changed a documented definition while looking like a formatting change.
-- ---------------------------------------------------------------------------
create or replace view public.market_context as
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
  -- Companies only, since 20260917060000. A fund is a basket of the names already
  -- counted here, so including one weights those names twice by an amount that depends
  -- on fund composition we do not track. See that migration's header.
  where t.active and not t.is_index and not t.is_fund
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
  'One row per trading date: VIX and its regime band, the VIX term structure, the S&P 500 close and '
  'watchlist breadth, each borrowed value carrying its own as-of date (decision 0034). Breadth counts '
  'COMPANIES only - funds are excluded because an ETF is a basket of names already counted, so '
  'breadth_tracked is 43 rather than the 53 rows on the grid. Null is never zero here; see '
  '20260915130000 for the three places that matters, and 20260917060000 for the fund exclusion.';
