-- 20260916060000_grid_equijoin.sql
-- Purpose:    fix the production timeout introduced by 20260915060000. Replaces the weekly band
--             join in `grid_cells` with an equi-join on a pre-lagged week key, and stops
--             `grid_status` and `digest_standing` scanning the whole of `grid_cells` to answer
--             questions `daily_features` answers from an index.
-- Depends on: weekly_features (20260914010000), grid_cells / digest_standing (20260913190000,
--             20260915060000), grid_status (20260913200000), daily_features (20260913064000).
-- Grants:     select on weekly_in_force to service_role. The replaced views keep their grants.
-- Reversing:  restore the bodies of grid_cells and digest_standing from 20260915060000, grid_status
--             from 20260913200000, re-create weekly_asof from 20260915060000, and drop
--             weekly_in_force. No data is touched; every object here is a plain view.
--
-- ---------------------------------------------------------------------------
-- WHAT BROKE, AND HOW IT REACHED PRODUCTION
--
-- The 23:00 digest of 2026-09-15 sent as "INCOMPLETE digest, date unknown". It sent at all only
-- because the retry work in #47 landed the day before; the retries themselves all failed:
--
--     unavailable   ["grid_status", "digest_standing"]
--     read_errors   both "canceling statement due to statement timeout"
--     read_attempts grid_status 3, digest_changes 1, digest_standing 3
--
-- Measured on production the next morning:
--
--     select * from grid_status                                 6,490 ms
--     select max(d), count(distinct symbol) from grid_cells      7,201 ms   (593,262 rows)
--        -> "Rows Removed by Join Filter: 10,641,781"
--
-- against a PostgREST statement timeout of about 8 s. The dashboard calls `grid_status` on every
-- ISR revalidation, so the page was one slow moment away from the same failure.
--
-- The cause is the weekly join added in 20260915060000:
--
--     join public.weekly_asof w
--       on  w.symbol = f.symbol
--       and w.week_start < date_trunc('week', f.d)::date
--       and (w.next_week_start is null or w.next_week_start >= date_trunc('week', f.d)::date)
--
-- That is a BAND join. There is no equality on the week, so the planner has nothing to hash or
-- merge on: for each symbol it pairs every daily bar against every weekly row and throws away the
-- ones that miss. Filtered to one date it costs about 20 ms, which is why it looked fine when the
-- grid was tested. Unfiltered - which is exactly what an aggregate over the whole view does - it is
-- quadratic in each symbol's history and gets worse every week the data grows.
--
-- This hazard was identified, measured at 8.8 s and written into decision 0035 as the reason
-- relative strength has no as-of layer - one day AFTER this join shipped, and without anyone going
-- back to check the code that already had it. The trap was documented by the person who had
-- already walked into it.
--
-- ---------------------------------------------------------------------------
-- THE FIX: SAME RULE, EXPRESSED AS AN EQUALITY
--
-- The rule is unchanged and still the one thing that must not drift (hard constraint 5):
--
--     the weekly value shown on day d comes from the newest week that STARTED STRICTLY BEFORE
--     the week containing d.
--
-- The band join searches for that week at read time. Instead, compute it once per weekly row:
-- for each (symbol, week W), carry the values of the PREVIOUS weekly row. Then the lookup for a
-- daily bar is a plain equality on its own week:
--
--     on w.symbol = f.symbol and w.week = date_trunc('week', f.d)::date
--
-- which lands on `weekly_features_pk (symbol, week_start)`.
--
-- WHY THIS IS THE SAME SET OF ROWS, not merely a similar one. The two agree as long as every week
-- that has a daily bar also has a weekly row for that symbol, because then "the newest week before
-- W" is always literally the row before W. That holds by construction - `weekly_bars` groups the
-- same `daily_bars` that `daily_features` is built from, so the weeks cannot disagree - but "holds
-- by construction" is how silent corruption gets in later. It is asserted instead:
-- check_formulas.sql fails the build if any (symbol, week) in daily_features has no weekly_features
-- row, and the existing weekly look-ahead and value checks compare grid_cells against the rule
-- directly.
--
-- The first week of each symbol's history still produces NO weekly cells - there is no earlier week
-- for it to show - which is what the band join did too. That is the `source_week_start is not null`
-- filter below, and it is the one place where forgetting the equivalence would show up as extra
-- rows rather than as a slow query.
--
-- MEASURED, same 40-symbol / 965-day / 539,600-cell shape, before and after:
--
--     select max(d), count(distinct symbol) from grid_cells    3,141 ms  ->  528 ms
--     select * from grid_status                                3,192 ms  ->   23 ms
--     select count(*) from digest_standing                     3,124 ms  ->    9 ms
--     select count(*) from grid_cells                          3,124 ms  ->  240 ms
--
-- The middle line is the one to read twice. The equi-join alone takes the aggregate from 3.1 s to
-- 528 ms - a real fix, and still an aggregate over half a million rows that the dashboard would run
-- on every revalidation. Reading daily_features instead takes the banner itself to 23 ms and, more
-- importantly, stops its cost scaling with the number of PARAMETERS. At 200 tickers (step 10) the
-- 528 ms line is roughly 2.5 s; the 23 ms line barely moves.
--
-- (The numbers in this block are from the CI sandbox, which is faster than production; the ratio is
-- what carries over. Production before-figures are in the incident section above.)
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- weekly_in_force: for each (symbol, week), the weekly values that are IN FORCE during that week -
-- that is, the values of the previous weekly bar.
--
-- This replaces `weekly_asof`, which stored each week's successor so a day could search for its
-- week. Nothing searches now, so the successor is no longer useful and the view is dropped at the
-- bottom of this file. The name changed with the shape on purpose: `asof` described a lookup, and
-- this describes a fact about a week.
--
-- Every week of history is a candidate SOURCE, the in-progress one included, exactly as before. It
-- can never be in force anywhere, because being in force requires a later week to exist and there
-- is none. As before, `is_complete` is deliberately not consulted: it is a fact about today, not
-- about the week being asked, and a backtest standing on some past date must not be able to see it.
-- ---------------------------------------------------------------------------
create view public.weekly_in_force as
select
  symbol,
  week,
  source_week_start,
  weeks_available,
  rsi_weekly,
  rsi_weekly_seed_ok,
  close_vs_ema21w,
  ema21w_seed_ok,
  close_vs_sma30w,
  close_vs_sma200w
from (
  select
    w.symbol,
    w.week_start                                       as week,
    lag(w.week_start)         over ws                  as source_week_start,
    lag(w.weeks_available)    over ws                  as weeks_available,
    lag(w.rsi_weekly)         over ws                  as rsi_weekly,
    lag(w.rsi_weekly_seed_ok) over ws                  as rsi_weekly_seed_ok,
    lag(w.close_vs_ema21w)    over ws                  as close_vs_ema21w,
    lag(w.ema21w_seed_ok)     over ws                  as ema21w_seed_ok,
    lag(w.close_vs_sma30w)    over ws                  as close_vs_sma30w,
    lag(w.close_vs_sma200w)   over ws                  as close_vs_sma200w
  from public.weekly_features w
  window ws as (partition by w.symbol order by w.week_start)
) shifted
-- A symbol's first week has no earlier week to show. No row, rather than a row of nulls: a null
-- value and an absent cell are different states on the grid (the first says "we have the week and
-- the number is unknown", the second says "there is no such week"), and the band join this replaces
-- produced nothing here.
where source_week_start is not null;

comment on view public.weekly_in_force is
  'For each (symbol, week), the weekly parameters IN FORCE during that week - the values of the '
  'previous weekly bar, carried forward. Lets a daily row equi-join on its own week instead of '
  'searching a range, which is what made an unfiltered read of grid_cells quadratic. source_week_start '
  'says which week the numbers are actually from. A symbol''s first week is absent by design. '
  'Replaces weekly_asof; see 20260916060000.';

grant select on public.weekly_in_force to service_role;

-- ---------------------------------------------------------------------------
-- grid_cells: identical output, equi-join instead of band join.
--
-- `create or replace view` keeps the column list byte-for-byte, so digest_changes, digest_standing
-- and every PostgREST read carry on untouched. The only change is inside the weekly branch.
-- ---------------------------------------------------------------------------
create or replace view public.grid_cells as
with daily_cells as (
  select
    f.symbol,
    f.d,
    c.param,
    c.value,
    c.seed_ok,
    f.bars_available,
    'daily'::text as timeframe
  from public.daily_features f
  join public.tickers t on t.symbol = f.symbol
  cross join lateral ( values
      ('close'::text,                f.close,                true),
      ('rsi_daily'::text,            f.rsi_daily,            f.rsi_daily_seed_ok),
      ('close_vs_sma50d'::text,      f.close_vs_sma50d,      true),
      ('close_vs_sma200d'::text,     f.close_vs_sma200d,     true),
      ('close_vs_ema21d'::text,      f.close_vs_ema21d,      f.ema21_seed_ok),
      ('pct_off_high_stored'::text,  f.pct_off_high_stored,  true),
      ('pct_above_low_stored'::text, f.pct_above_low_stored, true),
      ('pct_off_52w_high'::text,     f.pct_off_52w_high,     true),
      ('realized_vol_20'::text,      f.realized_vol_20,      true),
      ('volume_ratio'::text,         f.volume_ratio,         true)
    ) c(param, value, seed_ok)
  where t.active and not t.is_index
),
weekly_cells as (
  select
    f.symbol,
    f.d,
    c.param,
    c.value,
    c.seed_ok,
    -- WEEKS available, not bars. The grid uses this to explain a blank cell, and answering a
    -- weekly question with a daily count would send the reader looking for the wrong problem.
    w.weeks_available as bars_available,
    'weekly'::text as timeframe
  from public.daily_features f
  join public.tickers t on t.symbol = f.symbol and t.active and not t.is_index
  -- The whole point of this migration. Equality on the day's own week; `weekly_in_force` has
  -- already resolved which earlier week that week is showing.
  join public.weekly_in_force w
    on  w.symbol = f.symbol
    and w.week   = date_trunc('week', f.d)::date
  cross join lateral ( values
      ('rsi_weekly'::text,       w.rsi_weekly,       w.rsi_weekly_seed_ok),
      ('close_vs_ema21w'::text,  w.close_vs_ema21w,  w.ema21w_seed_ok),
      ('close_vs_sma30w'::text,  w.close_vs_sma30w,  true),
      ('close_vs_sma200w'::text, w.close_vs_sma200w, true)
    ) c(param, value, seed_ok)
),
cells as (
  select * from daily_cells
  union all
  select * from weekly_cells
)
select
  cells.symbol,
  cells.d,
  cells.param,
  cells.value,
  n.low  as norm_low,
  n.high as norm_high,
  case
    when cells.value is null    then null::text
    when not cells.seed_ok      then null::text
    when n.param is null        then null::text
    when n.low  is not null and cells.value < n.low  then 'below'::text
    when n.high is not null and cells.value > n.high then 'above'::text
    else 'normal'::text
  end as verdict,
  n.param is not null as has_norm,
  cells.value is not null and not cells.seed_ok as suppressed_warmup,
  cells.bars_available,
  cells.timeframe
from cells
left join public.norms n on n.param = cells.param;

comment on view public.grid_cells is
  'One row per (symbol, day, param), daily and weekly together. A weekly param repeats its value '
  'across the days of a week and steps on the week boundary; the value shown on day d is from the '
  'newest week that started before d''s own week, so it can never see the future. `timeframe` says '
  'which. Uncoloured (has_norm = false) is a normal state, not a missing threshold.';

-- ---------------------------------------------------------------------------
-- grid_status: ask the cheap source.
--
-- `data_through` and `symbols` were read as `max(d), count(distinct symbol)` from grid_cells - an
-- unfiltered aggregate over half a million rows to learn two facts that `daily_features` holds
-- directly, on an index, for every symbol the grid shows. The equi-join above already takes this
-- from 3.1 s to 118 ms; reading daily_features takes it to 3 ms, and - more to the point - stops
-- the banner's cost growing with the number of PARAMETERS rather than the number of symbols.
--
-- Same numbers, and the predicate is copied from grid_cells deliberately: the daily branch there is
-- daily_features joined to tickers on `active and not is_index`, so the set of symbols and the
-- newest date are identical by definition. The weekly branch is built from the same daily_features
-- rows, so it can neither add a symbol nor a later date.
--
-- The rest of the view is untouched, including the part that matters most - is_stale measures the
-- PIPELINE, not the gap to the newest bar (20260913200000).
-- ---------------------------------------------------------------------------
create or replace view public.grid_status as
with cfg as (
  select
    coalesce(
      (select (value #>> '{}')::numeric from public.flags where key = 'pipeline_stale_after_hours'),
      30
    ) as stale_after_hours
),
d as (
  select max(f.d) as data_through, count(distinct f.symbol) as symbols
  from public.daily_features f
  join public.tickers t on t.symbol = f.symbol
  where t.active and not t.is_index
),
good as (
  select max(finished_at) as last_success_at
  from public.ingest_runs
  where ok is true and finished_at is not null and detail ? 'daily'
),
latest as (
  select finished_at, ok, triggered_by
  from public.ingest_runs order by id desc limit 1
)
select
  d.data_through,
  d.symbols,
  (current_date - d.data_through)                                        as days_behind,
  good.last_success_at,
  round(extract(epoch from (now() - good.last_success_at)) / 3600.0, 1)  as hours_since_success,
  cfg.stale_after_hours,
  coalesce(
    extract(epoch from (now() - good.last_success_at)) / 3600.0 > cfg.stale_after_hours,
    true
  )                                                                      as is_stale,
  latest.finished_at                                                     as last_run_at,
  latest.ok                                                              as last_run_ok,
  latest.triggered_by                                                    as last_run_by
from d cross join cfg cross join good left join latest on true;

comment on view public.grid_status is
  'One row: how current the grid is and whether the page should say so. is_stale measures the '
  'PIPELINE - hours since the daily ingest last completed successfully - not the gap to the newest '
  'bar, so a market holiday does not read as a failure. data_through and days_behind are published '
  'as facts but are not the verdict. last_run_ok and is_stale answer different questions: a run '
  'can succeed and the pipeline still be behind, and a config-only sync is deliberately not '
  'counted as evidence that prices arrived. data_through/symbols read daily_features rather than '
  'grid_cells - same answer, and the banner stops costing an aggregate over every cell.';

-- ---------------------------------------------------------------------------
-- digest_standing: same change, same reason.
--
-- `c.d = (select max(d) from grid_cells)` made the nightly email aggregate the entire view to find
-- one date. This is the other read that timed out on 2026-09-15.
-- ---------------------------------------------------------------------------
create or replace view public.digest_standing as
select c.symbol, c.param, c.value, c.verdict
from public.grid_cells c
where c.d = (
        select max(f.d)
        from public.daily_features f
        join public.tickers t on t.symbol = f.symbol
        where t.active and not t.is_index
      )
  and c.timeframe = 'daily'
  and c.verdict = any (array['below','above']);

comment on view public.digest_standing is
  'Standing daily-timeframe exceptions on the latest date. Weekly excluded for the same reason as '
  'digest_changes. The latest date comes from daily_features, not from an aggregate over '
  'grid_cells - see 20260916060000.';

-- ---------------------------------------------------------------------------
-- weekly_asof is now unreferenced. Dropped WITHOUT cascade on purpose: if anything still depends
-- on it this migration fails here and says so, which is the check worth having. Verified before
-- writing this that the only mentions outside its own migration are in docs/CODEMAP.md and
-- docs/FEATURES.md, both updated in this PR.
-- ---------------------------------------------------------------------------
drop view public.weekly_asof;
