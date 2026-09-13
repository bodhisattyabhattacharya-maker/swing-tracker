-- 20260914010000_weekly_features.sql
-- Purpose:    the weekly parameter layer. `weekly_bars` rolls daily bars into ISO weeks;
--             `weekly_features` computes RSI(14), EMA(21), SMA(30W) and SMA(200W) over them.
--             Also extracts Wilder's recursion into one shared function so it stops existing once
--             per timeframe.
-- Depends on: daily_bars, daily_features (20260913064000), tickers.
-- Used by:    nothing yet. The grid gains weekly columns in a later PR.
-- Grants:     select to service_role; execute revoked from public.
-- Reversing:  drop weekly_features, weekly_bars; restore the previous body of daily_recursive from
--             20260913064000, and re-schedule swing-refresh-features with only the daily line.
--             daily_features is untouched and needs no rebuild - only a refresh.
--
-- ---------------------------------------------------------------------------
-- WHY THE RECURSION MOVES INTO A SHARED FUNCTION
--
-- Wilder's smoothing is the single most consequential formula in this system: a plain rolling mean
-- of gains and losses is a different indicator wearing the same name, and the gap runs to tens of
-- RSI points (hard constraint 7). Having it written out twice - once for daily, once for weekly -
-- is the most likely way this project ever ships two numbers that disagree.
--
-- So `recursive_indicators` takes the series as ARRAYS and knows nothing about tables or
-- timeframes. `daily_recursive` and `weekly_recursive` both become thin wrappers that hand it a
-- series. The formula exists once.
--
-- This rewrites a function the daily layer already depends on, which would normally be risky.
-- It is safe here for a specific reason: scripts/ci/check_formulas.sql compares daily_features
-- against an independent implementation at 1e-9, so a regression in this refactor fails the build
-- rather than reaching the dashboard. That gate landed one PR ago precisely so changes like this
-- one could be made at all.
--
-- WEEKLY BAR CONSTRUCTION, pinned because every weekly parameter depends on it (DEFINITIONS.md §3):
--   week starts MONDAY (ISO); open = first daily open, high = max, low = min, close = last daily
--   close, volume = sum. A holiday-shortened week is a normal week with fewer bars, not a gap.
--
-- WHAT "COMPLETE" MEANS, and why it is defined negatively: we have no market calendar, so we
-- cannot know that a week has ended. What we DO know is that the most recent week in the data is
-- the only one that can still gain bars. Every earlier week is finished. That definition needs no
-- calendar, handles holidays for free, and is why `is_complete` is simply "not the latest week".
-- Hard constraint 5 - weekly parameters read the last COMPLETED week - is enforced by readers
-- filtering on this flag, and `bars_in_week` is published so a reader can see a short week.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The formula, once, with no idea what a timeframe is.
--
-- Arrays rather than a table so it cannot accidentally couple to one. Both inputs must be ordered
-- oldest-first by the caller; an out-of-order series silently produces a wrong RSI, which is why
-- both call sites use an explicit `order by` inside array_agg rather than trusting row order.
-- ---------------------------------------------------------------------------
create or replace function public.recursive_indicators(
  p_dates  date[],
  p_closes double precision[]
)
returns table (
  d               date,
  rsi14           double precision,
  ema21           double precision,
  bars_available  integer
)
language plpgsql
immutable
set search_path = ''
as $$
declare
  i          integer;
  n          integer := coalesce(array_length(p_closes, 1), 0);
  c          double precision;
  prev_close double precision;
  gain       double precision;
  loss       double precision;
  sum_gain   double precision := 0;
  sum_loss   double precision := 0;
  avg_gain   double precision;
  avg_loss   double precision;
  alpha_rma  constant double precision := 1.0 / 14;
  sum_close  double precision := 0;
  ema        double precision;
  alpha_ema  constant double precision := 2.0 / 22;
  rs         double precision;
begin
  if n = 0 then return; end if;
  if coalesce(array_length(p_dates, 1), 0) <> n then
    raise exception 'recursive_indicators: % dates but % closes', array_length(p_dates, 1), n;
  end if;

  for i in 1..n loop
    c := p_closes[i];

    -- Wilder RSI(14). 14 CHANGES, so 15 bars: bars 2..15 build the seed as a simple mean, and
    -- bar 16 onward smooths with alpha = 1/14. DEFINITIONS.md §1.
    if prev_close is not null then
      gain := greatest(c - prev_close, 0);
      loss := greatest(prev_close - c, 0);
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

    if avg_gain is null then
      rsi14 := null;                                  -- still warming up
    elsif avg_gain = 0 and avg_loss = 0 then
      rsi14 := null;                                  -- no movement: undefined, not 50
    elsif avg_loss = 0 then
      rsi14 := 100;
    elsif avg_gain = 0 then
      rsi14 := 0;
    else
      rs := avg_gain / avg_loss;
      rsi14 := 100 - 100 / (1 + rs);
    end if;

    -- EMA(21): alpha = 2/(n+1), seeded with the simple mean of the first 21 closes.
    if i <= 21 then
      sum_close := sum_close + c;
      if i = 21 then ema := sum_close / 21; end if;
    else
      ema := ema + alpha_ema * (c - ema);
    end if;
    ema21 := ema;

    d := p_dates[i];
    bars_available := i;
    prev_close := c;
    return next;
  end loop;
end;
$$;

comment on function public.recursive_indicators(date[], double precision[]) is
  'Wilder RSI(14) and EMA(21) over an ordered series. Timeframe-agnostic on purpose: the daily and '
  'weekly wrappers both call this so the formula exists exactly once. DEFINITIONS.md section 1.';

revoke execute on function public.recursive_indicators(date[], double precision[]) from public;
grant execute on function public.recursive_indicators(date[], double precision[]) to service_role;

-- Now a thin wrapper. Same signature and same output as before, so daily_features needs no
-- redefinition - only a refresh. Its values must not move; the CI formula gate asserts that.
create or replace function public.daily_recursive(p_symbol text)
returns table (
  d               date,
  rsi14           double precision,
  ema21           double precision,
  bars_available  integer
)
language sql
stable
set search_path = ''
as $$
  select r.d, r.rsi14, r.ema21, r.bars_available
  from (
    select array_agg(b.d order by b.d)     as ds,
           array_agg(b.close order by b.d) as cs
    from public.daily_bars b
    where b.symbol = p_symbol
  ) s
  cross join lateral public.recursive_indicators(s.ds, s.cs) r
$$;

comment on function public.daily_recursive(text) is
  'Wilder RSI(14) and EMA(21) on daily bars for one symbol. A wrapper over recursive_indicators.';

-- ---------------------------------------------------------------------------
-- weekly_bars: daily bars rolled into ISO weeks.
-- ---------------------------------------------------------------------------
create view public.weekly_bars as
select
  b.symbol,
  date_trunc('week', b.d)::date                                as week_start,
  (array_agg(b.open  order by b.d))[1]                         as open,
  max(b.high)                                                  as high,
  min(b.low)                                                   as low,
  (array_agg(b.close order by b.d desc))[1]                    as close,
  sum(b.volume)                                                as volume,
  count(*)::int                                                as bars_in_week,
  max(b.d)                                                     as last_bar,
  -- Complete = not the most recent week FOR THIS SYMBOL. See the header: no calendar needed, and
  -- a holiday-shortened week is correctly complete rather than suspicious.
  (date_trunc('week', b.d)::date
     < max(date_trunc('week', b.d)::date) over (partition by b.symbol)) as is_complete
from public.daily_bars b
group by b.symbol, date_trunc('week', b.d)::date;

comment on view public.weekly_bars is
  'Daily bars rolled into ISO (Monday) weeks. close is the last daily close, not Friday''s - a '
  'holiday-shortened week is a normal week with fewer bars. is_complete is false only for the most '
  'recent week per symbol, which is the only one that can still gain bars; hard constraint 5 says '
  'readers take the last COMPLETE week.';

-- ---------------------------------------------------------------------------
-- weekly_features. Same shape as daily_features, over weekly bars.
--
-- SMA(200W) is ~3.85 years of history. Measured 2026-09-13 after the 5-year backfill: 33 of 36
-- equities clear it. The three that do not are short for a real reason rather than a data gap -
-- ARM listed 2023-09-14, ALAB 2024-03-20, SNDK 2025-02-24 - so their SMA(200W) is null and that is
-- the honest answer, not a bug to work around.
-- ---------------------------------------------------------------------------
create materialized view public.weekly_features as
with rec as (
  select s.symbol, f.d as week_start, f.rsi14, f.ema21, f.bars_available
  from (select distinct symbol from public.weekly_bars) s
  cross join lateral (
    select array_agg(w.week_start order by w.week_start) as ds,
           array_agg(w.close      order by w.week_start) as cs
    from public.weekly_bars w
    where w.symbol = s.symbol
  ) a
  cross join lateral public.recursive_indicators(a.ds, a.cs) f
),
base as (
  select
    w.symbol, w.week_start, w.close, w.is_complete, w.bars_in_week, w.last_bar,
    case when count(*) over w30  = 30  then avg(w.close) over w30  end as sma30w,
    case when count(*) over w200 = 200 then avg(w.close) over w200 end as sma200w
  from public.weekly_bars w
  window
    w30  as (partition by w.symbol order by w.week_start rows between 29  preceding and current row),
    w200 as (partition by w.symbol order by w.week_start rows between 199 preceding and current row)
)
select
  b.symbol,
  b.week_start,
  b.last_bar,
  b.close,
  b.is_complete,
  b.bars_in_week,
  rec.bars_available                                                as weeks_available,
  rec.rsi14                                                         as rsi_weekly,
  rec.ema21                                                         as ema21_weekly,
  b.sma30w,
  b.sma200w,
  case when rec.ema21 is not null then 100 * (b.close / rec.ema21 - 1) end as close_vs_ema21w,
  case when b.sma30w  is not null then 100 * (b.close / b.sma30w  - 1) end as close_vs_sma30w,
  case when b.sma200w is not null then 100 * (b.close / b.sma200w - 1) end as close_vs_sma200w,
  -- Seed-decay floors from DEFINITIONS.md §4, in WEEKS here rather than days. Same numbers - the
  -- floors are counts of bars, and a bar is whatever the timeframe says it is.
  (rec.bars_available >= 125)                                       as rsi_weekly_seed_ok,
  (rec.bars_available >= 97)                                        as ema21w_seed_ok
from base b
join rec on rec.symbol = b.symbol and rec.week_start = b.week_start;

comment on materialized view public.weekly_features is
  'Weekly parameters per (symbol, week_start). Derived - rebuild with REFRESH MATERIALIZED VIEW. '
  'Readers must filter is_complete, or they read a partial week (hard constraint 5). SMA(200W) is '
  'null for ARM, ALAB and SNDK because they listed too recently, which is honest rather than '
  'broken. Formulas: DEFINITIONS.md sections 1-4.';

create unique index weekly_features_pk on public.weekly_features (symbol, week_start);
create index weekly_features_week_idx on public.weekly_features (week_start);

grant select on public.weekly_bars, public.weekly_features to service_role;

-- ---------------------------------------------------------------------------
-- THE PART THAT IS EASY TO FORGET, AND WHICH CI CAUGHT RATHER THAN A HUMAN
--
-- A materialized view is populated ONCE, when it is created. Nothing refreshes it afterwards
-- except something that says so. `swing-refresh-features` (20260913183000) names daily_features
-- explicitly, so without this block weekly_features would be frozen at whatever the data looked
-- like the minute this migration ran - correct on day one, silently a day staler every day after,
-- and with no error anywhere. Exactly the failure mode this project has now hit six times: an
-- operation that succeeds and changes nothing.
--
-- Found by the CI gate: the weekly assertions came back MISSING rather than FAIL, because in CI
-- the migration runs against an empty database and the fixture loads afterwards. The fix in
-- scripts/ci/run.sh (refresh after the fixture) is the same fix as this one, which is the useful
-- part - CI reproduced the production hazard rather than merely tripping over its own ordering.
--
-- Re-scheduled by name, so this replaces the existing job rather than adding a second one. The
-- 22:45 slot and the reasoning behind it are unchanged; only the body grows a second statement.
-- Both refreshes are CONCURRENTLY, which each matview's unique index permits, and both are real
-- SQL running inline - so unlike the ingest, a failure here is loud in cron.job_run_details.
--
-- Order within the job does not matter: weekly_features reads daily_bars through weekly_bars, not
-- daily_features. They are siblings, not a chain.
-- ---------------------------------------------------------------------------
select cron.unschedule(jobid) from cron.job where jobname = 'swing-refresh-features';

select cron.schedule(
  'swing-refresh-features',
  '45 22 * * 1-5',
  $job$
  refresh materialized view concurrently public.daily_features;
  refresh materialized view concurrently public.weekly_features;
  $job$
);
