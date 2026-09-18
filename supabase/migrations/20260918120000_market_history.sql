-- 20260918120000_market_history.sql
--
-- `market_history`: the market block's series, over its whole span, with the VIX 20-day average
-- precomputed. Feeds the four market-history charts.
--
-- A MATVIEW, NOT A VIEW, AND THE REASON WAS MEASURED RATHER THAN ASSUMED.
--
-- The first draft of this was a plain view, on the reasoning that `market_context` is one row per
-- date - 1,239 of them - so a full scan is nothing. That reasoning was wrong in a way worth writing
-- down: `market_context` is itself a VIEW. Scanning it recomputes watchlist breadth by aggregating
-- 71,575 `daily_features` rows and does three correlated index lookups per date, 3,717 in total.
--
-- Measured on production, 2026-09-18, for the six-month window these charts need:
--
--     Execution Time: 143.962 ms     Buffers: shared hit=28271
--
-- and `market_context` appeared TWICE in the plan, because `where d >= (select max(d) - 200 from
-- market_context)` makes the planner build the whole thing once for the subquery and again for the
-- window. Every ISR revalidation would pay that, and the number would grow with the watchlist
-- rather than with the chart.
--
-- This is the same family as 20260916060000 (a band join with no equality) and decision 0042 (a
-- filter cannot pass through a window function): a read that looks like it touches a few rows and
-- touches everything. The answer is the same one - materialise it, index it, refresh it on the
-- schedule - and so is the hazard: a matview nothing refreshes is frozen at the moment it was
-- created. The refresh job below is re-scheduled by name to include it, and
-- `scripts/ci/check_formulas.sql` fails the build if any matview is missing from that job.
--
-- WHY THE WHOLE SPAN AND NOT SIX MONTHS. The window the charts draw is a decision for the page, not
-- for the store. Materialising everything costs the same refresh and leaves the six-month choice to
-- an indexed `where d >= ...`, so changing the window later is a query change rather than a
-- migration. It is 1,239 rows.

create materialized view public.market_history as
with base as (
  select
    d, vix, vix_band, vix3m, term_structure, spx_close, breadth_pct,
    breadth_tracked, index_days_behind
  from public.market_context
)
select
  d,
  vix,
  vix_band,
  vix3m,
  term_structure,
  spx_close,
  breadth_pct,
  breadth_tracked,
  index_days_behind,
  -- The 20-day average of VIX, over TRADING rows rather than calendar days: `rows between 19
  -- preceding and current row` counts rows in this series, and this series has one row per session.
  -- Decision 0035's rule - bars, not days - applies to an average exactly as it applies to a lag.
  avg(vix) over w  as vix_ma20,
  -- HOW MANY ROWS THE AVERAGE ACTUALLY HAD. Postgres happily averages a 3-row window and returns a
  -- number that looks like a 20-day average, which is the warm-up problem of hard constraint 8 in
  -- a new place. The page must not draw the first 19 points of this line, and it cannot know not to
  -- unless the count travels with the value.
  count(vix) over w as vix_ma20_bars
from base
window w as (order by d rows between 19 preceding and current row);

-- Unique, so the page's `where d >= ...` is an index scan and so `refresh ... concurrently` is
-- legal - it requires a unique index on the matview.
create unique index market_history_pk on public.market_history (d);

comment on materialized view public.market_history is
  'Market block series over the full span, with the VIX 20-bar average and its row count. '
  'Derived from market_context - rebuild with REFRESH MATERIALIZED VIEW CONCURRENTLY. '
  'vix_ma20 is meaningless below vix_ma20_bars = 20; the page must not plot those points.';

grant select on public.market_history to service_role;

-- ---------------------------------------------------------------------------
-- THE REFRESH JOB, re-scheduled by name so this REPLACES it rather than adding a second one.
-- 22:45 slot unchanged.
--
-- market_history reads market_context, which reads daily_features. It therefore goes LAST, after
-- daily_features has been rebuilt - the same ordering argument 20260917120000 made for
-- daily_signals, for the same reason: a stale parent produces a stale-but-consistent child and
-- nothing looks wrong.
-- ---------------------------------------------------------------------------
select cron.unschedule(jobid) from cron.job where jobname = 'swing-refresh-features';

select cron.schedule(
  'swing-refresh-features',
  '45 22 * * 1-5',
  $job$
  refresh materialized view concurrently public.daily_features;
  refresh materialized view concurrently public.weekly_features;
  refresh materialized view concurrently public.daily_signals;
  refresh materialized view concurrently public.market_history;
  $job$
);
