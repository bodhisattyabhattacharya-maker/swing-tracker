-- scripts/ci/check_formulas.sql
--
-- The formula gate. Compares `daily_features` against values an independent implementation
-- computed from the same synthetic series (scripts/ci/fixture.sql), and asserts the degenerate
-- cases behave as DEFINITIONS.md says they should.
--
-- Returns one row per check, same shape as scripts/verify_parameters.sql, so both read alike and
-- CI can gate on the same condition: **no row may have status other than PASS.**
--
-- WHAT THIS GATES: that our SQL computes Wilder's smoothing, the EMA seeding, the window frames
-- and the annualisation the way an implementation written independently from DEFINITIONS.md does.
-- That is the regression this exists to catch, and it is the one that gets easy to introduce as
-- the parameter count grows.
--
-- WHAT IT DOES NOT GATE: the vendor's data or the adjustment basis. The MU golden values cover
-- that and remain a manual check against production - see DEFINITIONS.md §6. Neither substitutes
-- for the other, and a green CI run is not evidence that the numbers on the dashboard match
-- TradingView.
--
-- TOLERANCE: 1e-9 relative. Both sides are float64 doing the same arithmetic in a different order,
-- so anything beyond accumulation noise is a real difference. This is deliberately far tighter
-- than the 1e-3 used against the hand-read TradingView goldens, where the gap is a genuine
-- vendor/rounding floor rather than accumulation.

-- ---------------------------------------------------------------------------
-- A helper for the `plan` checks at the bottom of this file, which assert the SHAPE of a query
-- plan rather than a value. EXPLAIN cannot appear in a subquery, so it is wrapped.
--
-- `analyze false`: the assertion is structural. Timing a plan on a 200-bar fixture would prove
-- nothing about production and would make the gate flaky on a busy CI machine. What it CAN prove,
-- at any size, is that the planner found an equality to join on - and the outage of 2026-09-15 was
-- caused precisely by there not being one.
--
-- Output is suppressed so this stays a file of check rows: CI counts the rows this file emits, and
-- a stray CREATE FUNCTION tag would be counted as one.
-- ---------------------------------------------------------------------------
\o /dev/null
create or replace function pg_temp.plan_of(q text) returns text
language plpgsql as $fn$
declare line text; out text := '';
begin
  for line in execute 'explain (analyze false, costs false) ' || q loop
    out := out || line || E'\n';
  end loop;
  return out;
end
$fn$;

-- Row count of any relation by name. Used by the "no matview is empty" check, which has to be
-- generic: naming the matviews here would mean remembering to add the next one, and forgetting is
-- precisely the failure it exists to catch.
create or replace function pg_temp.rows_in(rel text) returns bigint
language plpgsql as $fn2$
declare n bigint;
begin
  execute 'select count(*) from ' || rel into n;
  return n;
end
$fn2$;
\o

-- ---------------------------------------------------------------------------
-- The scheduled cron expression, or null where pg_cron is not installed.
--
-- DYNAMIC SQL, AND NOT BY PREFERENCE. A plain `select schedule from cron.job` inside a guarded
-- `case` still fails: Postgres resolves relation names when it PARSES the statement, long before
-- any branch is evaluated, so on a database without pg_cron - which is every CI database - the
-- reference takes down the whole file, not just this check. Found by running it.
--
-- Same reason `pg_temp.plan_of` above is a function: some things cannot be expressions.
-- ---------------------------------------------------------------------------
\o /dev/null
create or replace function pg_temp.scheduled_cron(job text) returns text
language plpgsql stable as $fn$
declare out text;
begin
  if to_regclass('cron.job') is null then return null; end if;
  execute 'select schedule from cron.job where jobname = $1' into out using job;
  return out;
end $fn$;
\o

-- ---------------------------------------------------------------------------
-- STALENESS IS SCHEDULE-AWARE (migration 20260920223000, decision 0056).
--
-- The rule it replaced was `hours_since_success > 30`, which on a pipeline that only runs Monday
-- to Friday was true for 42 of every 168 hours - a quarter of all wall-clock time, every week,
-- with nothing wrong. Measured, not estimated: an hour-by-hour simulation of a perfectly healthy
-- week is in the PR that introduced this.
--
-- Three things to hold, and the third is the one a fix like this gets wrong:
--   1. The schedule it reasons from is the schedule the job runs on. `flags.ingest_cron` is a
--      duplicate of `cron.job.schedule`; a duplicate that cannot drift silently is a different
--      thing from a duplicate, which is the VIX_BAND argument.
--   2. A weekend, and a Monday before the evening fire, are quiet.
--   3. **A genuinely missed run is still loud.** A fix for a false positive that goes silent on
--      real failures has made the page worse, not better.
-- ---------------------------------------------------------------------------

with expected as (
  select e.d, e.param, e.expected,
         case e.param
           when 'rsi_daily'       then f.rsi_daily
           when 'ema21_daily'     then f.ema21_daily
           when 'sma50'           then f.sma50
           when 'sma200'          then f.sma200
           when 'realized_vol_20' then f.realized_vol_20
           when 'volume_ratio'    then f.volume_ratio
         end as actual,
         (f.symbol is null) as row_missing
  from ci_expected e
  left join public.daily_features f on f.symbol = 'SYNTH' and f.d = e.d
),
formula_rows as (
  select
    'formula'::text as section,
    param || ' @ ' || d as check_name,
    case
      when row_missing                              then 'MISSING'
      when expected is null and actual is null       then 'PASS'
      when expected is null or actual is null        then 'FAIL'
      when abs(actual - expected)
             <= 1e-9 * greatest(abs(expected), 1e-6) then 'PASS'
      else 'FAIL'
    end as status,
    coalesce(to_char(expected, 'FM999999990.0000000000'), '(null)') as expected_v,
    coalesce(to_char(actual,   'FM999999990.0000000000'), '(null)') as actual_v,
    case
      when row_missing then 'no daily_features row for SYNTH on this date - fixture did not load'
      when expected is null and actual is null then 'both null, as the reference says it should be'
      when expected is null or actual is null then 'one side is null and the other is not'
      else 'relative diff ' ||
           trim(to_char(abs(actual - expected) / greatest(abs(expected), 1e-6), '0.000EEEE'))
    end as note
  from expected
),
-- The weekly layer, given the same treatment. The rollup is where a subtle error is most likely
-- and least visible - Friday's close instead of the last close, Sunday weeks, a holiday week read
-- as a gap - and none of those would trip an invariant.
weekly as (
  select e.week_start, e.param, e.expected,
         case e.param
           when 'rsi_weekly'   then f.rsi_weekly
           when 'ema21_weekly' then f.ema21_weekly
           when 'sma30w'       then f.sma30w
         end as actual,
         (f.symbol is null) as row_missing
  from ci_expected_weekly e
  left join public.weekly_features f on f.symbol = 'SYNTH' and f.week_start = e.week_start
),
weekly_rows as (
  select
    'formula (weekly)'::text as section,
    param || ' @ ' || week_start as check_name,
    case
      when row_missing                               then 'MISSING'
      when expected is null and actual is null        then 'PASS'
      when expected is null or actual is null         then 'FAIL'
      when abs(actual - expected)
             <= 1e-9 * greatest(abs(expected), 1e-6)  then 'PASS'
      else 'FAIL'
    end as status,
    coalesce(to_char(expected, 'FM999999990.0000000000'), '(null)') as expected_v,
    coalesce(to_char(actual,   'FM999999990.0000000000'), '(null)') as actual_v,
    case
      when row_missing then 'no weekly_features row for SYNTH in this week'
      when expected is null and actual is null then 'both null, as the reference says'
      when expected is null or actual is null then 'one side is null and the other is not'
      else 'relative diff ' ||
           trim(to_char(abs(actual - expected) / greatest(abs(expected), 1e-6), '0.000EEEE'))
    end as note
  from weekly
),
-- The degenerate cases. Each is a statement DEFINITIONS.md makes, asserted rather than assumed.
degenerate as (
  select * from (
    select 'degenerate'::text as section,
           'a flat series leaves RSI undefined, not 50 or 100'::text as check_name,
           case when (select count(*) from public.daily_features
                      where symbol = 'FLAT' and rsi_daily is not null) = 0
                then 'PASS' else 'FAIL' end as status,
           '0'::text as expected_v,
           (select count(*)::text from public.daily_features
             where symbol = 'FLAT' and rsi_daily is not null) as actual_v,
           'zero gain AND zero loss has no defined RSI; returning 50 would invent a reading'::text as note
    union all
    select 'degenerate', 'a series below every window publishes nothing',
           case when (select count(*) from public.daily_features
                      where symbol = 'SHORT'
                        and (rsi_daily is not null or ema21_daily is not null
                             or sma50 is not null or sma200 is not null)) = 0
                then 'PASS' else 'FAIL' end,
           '0',
           (select count(*)::text from public.daily_features
             where symbol = 'SHORT' and (rsi_daily is not null or ema21_daily is not null
                   or sma50 is not null or sma200 is not null)),
           'a 10-bar history cannot produce a 14-bar or 21-bar indicator'
    union all
    select 'degenerate', 'a close-only series has no high, low or volume parameters',
           case when (select count(*) from public.daily_features
                      where symbol = '^IDX'
                        and (pct_off_high_stored is not null or volume_ratio is not null)) = 0
                then 'PASS' else 'FAIL' end,
           '0',
           (select count(*)::text from public.daily_features
             where symbol = '^IDX' and (pct_off_high_stored is not null or volume_ratio is not null)),
           'FRED publishes a close only; inventing a high would corrupt every extreme'
    union all
    select 'degenerate', 'an index never appears in the grid',
           case when (select count(*) from public.grid_cells where symbol = '^IDX') = 0
                then 'PASS' else 'FAIL' end,
           '0',
           (select count(*)::text from public.grid_cells where symbol = '^IDX'),
           'indices are market context, not rows'
    union all
    -- The scheduling migrations are applied against stubs, so this asserts the only thing a stub
    -- CAN prove about them: that they registered what they claimed, and did not embed a secret.
    select 'weekly', 'exactly one week is incomplete per symbol',
           case when (select count(*) from (
                        select symbol from public.weekly_features
                        where not is_complete group by symbol having count(*) <> 1) x) = 0
                then 'PASS' else 'FAIL' end,
           '0',
           (select count(*)::text from (
              select symbol from public.weekly_features
              where not is_complete group by symbol having count(*) <> 1) x),
           'only the most recent week can still gain bars; any other incomplete week is a bug'
    union all
    select 'weekly', 'weekly closes equal the last daily close of the week',
           case when (select count(*) from public.weekly_bars w
                      join public.daily_bars b
                        on b.symbol = w.symbol and b.d = w.last_bar
                      where b.close <> w.close) = 0
                then 'PASS' else 'FAIL' end,
           '0',
           (select count(*)::text from public.weekly_bars w
             join public.daily_bars b on b.symbol = w.symbol and b.d = w.last_bar
             where b.close <> w.close),
           'taking Friday''s close rather than the last close is the classic weekly rollup bug'
    union all
    select 'weekly', 'every daily bar lands in exactly one week',
           case when (select count(*) from public.daily_bars)
                   = (select coalesce(sum(bars_in_week), 0) from public.weekly_bars)
                then 'PASS' else 'FAIL' end,
           (select count(*)::text from public.daily_bars),
           (select coalesce(sum(bars_in_week), 0)::text from public.weekly_bars),
           'a bar counted twice or dropped would shift every weekly aggregate'
    union all
    -- ---------------------------------------------------------------------------
    -- The weekly-to-daily as-of join (20260915060000). This is the one place a backtest can be
    -- silently corrupted, so the rule is re-derived here a DIFFERENT WAY than the view computes it
    -- - a correlated max() rather than a lead() range join - and the two must agree exactly.
    --
    -- WHICH OF THESE IS LOAD-BEARING, stated because it is not obvious. Only the first one - the
    -- value comparison - can catch the view picking the WRONG WEEK. Verified by changing the view's
    -- `<` to `<=` so that a day could see its own week: that check failed with 230 mismatches and
    -- every other check here still passed. The look-ahead check below resolves the source week by
    -- the correct rule, so it proves the correct week had ended, not that the view used it. The
    -- others are shape checks. Read them as one set, not as five independent guarantees.
    -- ---------------------------------------------------------------------------
    select 'as-of', 'every weekly cell matches an independent as-of lookup',
           case when (select count(*) from public.grid_cells c
                      where c.timeframe = 'weekly'
                        and c.param = 'rsi_weekly'
                        and c.value is distinct from (
                              select f.rsi_weekly from public.weekly_features f
                              where f.symbol = c.symbol
                                and f.week_start < date_trunc('week', c.d)::date
                              order by f.week_start desc limit 1)) = 0
                then 'PASS' else 'FAIL' end,
           '0',
           (select count(*)::text from public.grid_cells c
             where c.timeframe = 'weekly' and c.param = 'rsi_weekly'
               and c.value is distinct from (
                     select f.rsi_weekly from public.weekly_features f
                     where f.symbol = c.symbol and f.week_start < date_trunc('week', c.d)::date
                     order by f.week_start desc limit 1)),
           'the lead() range join and a correlated max() must pick the same week, or one of them is wrong'
    union all
    -- Resolves the SOURCE WEEK by the rule, then asserts that week had finished. Written first as a
    -- join on value equality, which failed with 3,347 spurious matches: `is not distinct from` makes
    -- every null value match every null week, and identical floats match across unrelated weeks. A
    -- check must identify the row it is judging, not guess it from a value.
    select 'as-of', 'the week a cell is sourced from ended before the day it is shown',
           case when (select count(*) from public.grid_cells c
                      cross join lateral (
                        select f.last_bar from public.weekly_features f
                        where f.symbol = c.symbol
                          and f.week_start < date_trunc('week', c.d)::date
                        order by f.week_start desc limit 1) src
                      where c.timeframe = 'weekly' and c.param = 'rsi_weekly'
                        and src.last_bar >= c.d) = 0
                then 'PASS' else 'FAIL' end,
           '0',
           (select count(*)::text from public.grid_cells c
             cross join lateral (
               select f.last_bar from public.weekly_features f
               where f.symbol = c.symbol and f.week_start < date_trunc('week', c.d)::date
               order by f.week_start desc limit 1) src
             where c.timeframe = 'weekly' and c.param = 'rsi_weekly'
               and src.last_bar >= c.d),
           'a weekly value sourced from a bar on or after the day it is shown is look-ahead - hard constraint 5'
    union all
    select 'as-of', 'a weekly value is constant within its week',
           case when (select count(*) from (
                        select c.symbol, date_trunc('week', c.d) wk, count(distinct c.value) n
                        from public.grid_cells c
                        where c.timeframe = 'weekly' and c.param = 'rsi_weekly' and c.value is not null
                        group by 1,2 having count(distinct c.value) > 1) x) = 0
                then 'PASS' else 'FAIL' end,
           '0',
           (select count(*)::text from (
              select c.symbol, date_trunc('week', c.d) wk
              from public.grid_cells c
              where c.timeframe = 'weekly' and c.param = 'rsi_weekly' and c.value is not null
              group by 1,2 having count(distinct c.value) > 1) x),
           'a weekly bar has one value; it may step on the week boundary and nowhere else'
    union all
    select 'as-of', 'the first week of a symbol has no weekly cells',
           case when (select count(*) from public.grid_cells c
                      where c.timeframe = 'weekly' and c.value is not null
                        and date_trunc('week', c.d)::date <= (
                              select min(f.week_start) from public.weekly_features f
                              where f.symbol = c.symbol)) = 0
                then 'PASS' else 'FAIL' end,
           '0',
           (select count(*)::text from public.grid_cells c
             where c.timeframe = 'weekly' and c.value is not null
               and date_trunc('week', c.d)::date <= (
                     select min(f.week_start) from public.weekly_features f where f.symbol = c.symbol)),
           'there is no completed week before the first one, so those days must be blank rather than borrowing'
    union all
    select 'as-of', 'timeframe is only daily or weekly',
           case when (select count(*) from public.grid_cells
                      where timeframe not in ('daily','weekly')) = 0
                then 'PASS' else 'FAIL' end,
           '0',
           (select count(*)::text from public.grid_cells where timeframe not in ('daily','weekly')),
           'a third value would silently fall through every filter written against this column'
    union all
    select 'as-of', 'the ten daily params survived the view rewrite',
           case when (select count(distinct param) from public.grid_cells
                      where timeframe = 'daily') = 10
                then 'PASS' else 'FAIL' end,
           '10',
           (select count(distinct param)::text from public.grid_cells where timeframe = 'daily'),
           'grid_cells was replaced in place; dropping a daily param would be invisible on the page'
    union all
    select 'digest', 'no weekly param reaches the digest',
           case when (select count(*) from public.digest_changes where param like '%weekly%'
                                                                   or param like '%w')
                    + (select count(*) from public.digest_standing where param like '%weekly%'
                                                                      or param like '%w') = 0
                then 'PASS' else 'FAIL' end,
           '0',
           ((select count(*) from public.digest_changes where param like '%weekly%' or param like '%w')
          + (select count(*) from public.digest_standing where param like '%weekly%' or param like '%w'))::text,
           'weekly params step for the whole watchlist on one Monday; that is the calendar, not news'
    union all
    -- ---------------------------------------------------------------------------
    -- The market block (20260915130000). The fixture supplies ^VIX, ^VIX3M and ^GSPC shaped to hit
    -- every band, both sides of the term structure, gaps in each series, and dates with no index
    -- data at all - so these assert behaviour rather than merely that the view parses.
    -- ---------------------------------------------------------------------------
    select 'market', 'every VIX band matches its own value',
           case when (select count(*) from public.market_context
                      where vix is not null
                        and vix_band is distinct from
                            case when vix < 16 then '<16' when vix < 30 then '16-30'
                                 when vix < 50 then '30-50' when vix < 80 then '50-80'
                                 else '>80' end) = 0
                then 'PASS' else 'FAIL' end,
           '0',
           (select count(*)::text from public.market_context
             where vix is not null
               and vix_band is distinct from
                   case when vix < 16 then '<16' when vix < 30 then '16-30'
                        when vix < 50 then '30-50' when vix < 80 then '50-80'
                        else '>80' end),
           'the bands must be exhaustive and disjoint - a value falling between two is unreachable'
    union all
    select 'market', 'all five bands occur in the fixture',
           case when (select count(distinct vix_band) from public.market_context
                      where vix_band is not null) = 5
                then 'PASS' else 'FAIL' end,
           '5',
           (select count(distinct vix_band)::text from public.market_context where vix_band is not null),
           'a band never exercised is a band never tested; >80 has happened once in eleven years'
    union all
    select 'market', 'term structure is never computed across two dates',
           case when (select count(*) from public.market_context
                      where term_structure is not null and vix3m_as_of is distinct from vix_as_of) = 0
                then 'PASS' else 'FAIL' end,
           '0',
           (select count(*)::text from public.market_context
             where term_structure is not null and vix3m_as_of is distinct from vix_as_of),
           'a ratio of two series taken at different moments is a different quantity, not a stale one'
    union all
    select 'market', 'a VIX day with no VIX3M reports null, not a number',
           case when (select count(*) from public.market_context
                      where vix is not null and vix3m_as_of is distinct from vix_as_of
                        and term_structure is not null) = 0
                then 'PASS' else 'FAIL' end,
           '0',
           (select count(*)::text from public.market_context
             where vix is not null and vix3m_as_of is distinct from vix_as_of and term_structure is not null),
           '0 would read as a flat curve, which is a real and different market state'
    union all
    select 'market', 'no index value is ever dated after the row it appears on',
           case when (select count(*) from public.market_context
                      where vix_as_of > d or vix3m_as_of > d or spx_as_of > d) = 0
                then 'PASS' else 'FAIL' end,
           '0',
           (select count(*)::text from public.market_context
             where vix_as_of > d or vix3m_as_of > d or spx_as_of > d),
           'an as-of join that reaches forward is look-ahead, the same defect as the weekly one'
    union all
    select 'market', 'the as-of VIX is the newest one on or before the date',
           case when (select count(*) from public.market_context mc
                      where mc.vix_as_of is distinct from (
                        select max(b.d) from public.daily_bars b
                        where b.symbol = '^VIX' and b.d <= mc.d)) = 0
                then 'PASS' else 'FAIL' end,
           '0',
           (select count(*)::text from public.market_context mc
             where mc.vix_as_of is distinct from (
               select max(b.d) from public.daily_bars b where b.symbol = '^VIX' and b.d <= mc.d)),
           're-derived with max() against the view''s lateral limit-1, the same cross-check as weekly'
    union all
    select 'market', 'breadth is null exactly when nobody is eligible',
           case when (select count(*) from public.market_context
                      where (breadth_eligible = 0) <> (breadth_pct is null)) = 0
                then 'PASS' else 'FAIL' end,
           '0',
           (select count(*)::text from public.market_context
             where (breadth_eligible = 0) <> (breadth_pct is null)),
           '0% would read as every name below its 200 SMA - the most bearish value the field has'
    union all
    select 'market', 'breadth stays within 0..100',
           case when (select count(*) from public.market_context
                      where breadth_pct is not null and (breadth_pct < 0 or breadth_pct > 100)) = 0
                then 'PASS' else 'FAIL' end,
           '0',
           (select count(*)::text from public.market_context
             where breadth_pct is not null and (breadth_pct < 0 or breadth_pct > 100)),
           'a share of a population cannot leave its own bounds'
    union all
    select 'market', 'eligible never exceeds tracked',
           case when (select count(*) from public.market_context where breadth_eligible > breadth_tracked) = 0
                then 'PASS' else 'FAIL' end,
           '0',
           (select count(*)::text from public.market_context where breadth_eligible > breadth_tracked),
           'names without 200 bars leave BOTH numerator and denominator, not just the numerator'
    union all
    -- ---------------------------------------------------------------------------
    -- Relative strength (20260915140000). The fixture's ^GSPC starts 30 days after the equities and
    -- shares their calendar thereafter, so these cover both the no-SPX-yet case and the normal one.
    -- ---------------------------------------------------------------------------
    select 'rs', 'a row exists only where both legs have a bar',
           case when (select count(*) from public.relative_strength r
                      where not exists (select 1 from public.daily_bars b
                                        where b.symbol = '^GSPC' and b.d = r.d)) = 0
                then 'PASS' else 'FAIL' end,
           '0',
           (select count(*)::text from public.relative_strength r
             where not exists (select 1 from public.daily_bars b
                               where b.symbol = '^GSPC' and b.d = r.d)),
           'an RS row on a date SPX never traded would mean the two legs ended on different sessions'
    union all
    select 'rs', 'rs is null until the symbol has n bars of its own',
           case when (select count(*) from public.relative_strength r
                      join lateral (select count(*) n from public.daily_bars b
                                    where b.symbol = r.symbol and b.d <= r.d) c on true
                      where (c.n <= 63  and r.rs_63b  is not null)
                         or (c.n <= 126 and r.rs_126b is not null)
                         or (c.n <= 252 and r.rs_252b is not null)) = 0
                then 'PASS' else 'FAIL' end,
           '0',
           (select count(*)::text from public.relative_strength r
             join lateral (select count(*) n from public.daily_bars b
                           where b.symbol = r.symbol and b.d <= r.d) c on true
             where (c.n <= 63  and r.rs_63b  is not null)
                or (c.n <= 126 and r.rs_126b is not null)
                or (c.n <= 252 and r.rs_252b is not null)),
           'a 63-bar return from 40 bars is a different statistic wearing the same label'
    union all
    select 'rs', 'rs re-derived from raw bars matches the view',
           case when (select count(*) from public.relative_strength r
                      join lateral (
                        select (select b.close from public.daily_bars b
                                where b.symbol = r.symbol and b.d <= r.d
                                order by b.d desc offset 63 limit 1) as sym_then,
                               (select b.close from public.daily_bars b
                                where b.symbol = r.symbol and b.d = r.d) as sym_now,
                               (select b.close from public.daily_bars b
                                where b.symbol = '^GSPC' and b.d <= r.d
                                order by b.d desc offset 63 limit 1) as spx_then,
                               (select b.close from public.daily_bars b
                                where b.symbol = '^GSPC' and b.d = r.d) as spx_now) q on true
                      where q.sym_then is not null and q.spx_then is not null
                        and abs(r.rs_63b - (100.0*((q.sym_now/q.sym_then - 1) - (q.spx_now/q.spx_then - 1))))
                            > 1e-9 * greatest(abs(r.rs_63b), 1e-6)) = 0
                then 'PASS' else 'FAIL' end,
           '0',
           (select count(*)::text from public.relative_strength r
             join lateral (
               select (select b.close from public.daily_bars b
                       where b.symbol = r.symbol and b.d <= r.d order by b.d desc offset 63 limit 1) as sym_then,
                      (select b.close from public.daily_bars b where b.symbol = r.symbol and b.d = r.d) as sym_now,
                      (select b.close from public.daily_bars b
                       where b.symbol = '^GSPC' and b.d <= r.d order by b.d desc offset 63 limit 1) as spx_then,
                      (select b.close from public.daily_bars b where b.symbol = '^GSPC' and b.d = r.d) as spx_now) q on true
             where q.sym_then is not null and q.spx_then is not null
               and abs(r.rs_63b - (100.0*((q.sym_now/q.sym_then - 1) - (q.spx_now/q.spx_then - 1))))
                   > 1e-9 * greatest(abs(r.rs_63b), 1e-6)),
           'offset-63 against lag(63): a different mechanism reaching the same bar, or one is wrong'
    union all
    select 'rs', 'a symbol never scores against itself',
           case when (select count(*) from public.relative_strength where symbol like '^%') = 0
                then 'PASS' else 'FAIL' end,
           '0',
           (select count(*)::text from public.relative_strength where symbol like '^%'),
           'an index measured against the index is identically zero and pure noise in the grid'
    union all
    select 'scheduling', 'all four jobs registered exactly once',
           case when (select count(*) from cron.job where jobname like 'swing-%') = 4
                then 'PASS' else 'FAIL' end,
           '4',
           (select count(*)::text from cron.job where jobname like 'swing-%'),
           'a re-applied migration must not leave duplicates firing alongside the new ones'
    union all
    select 'scheduling', 'the index catch-up asks for the indices scope, not all',
           case when (select count(*) from cron.job
                      where jobname = 'swing-refresh-indices'
                        and command like '%scope=indices%') = 1
                then 'PASS' else 'FAIL' end,
           '1',
           (select count(*)::text from cron.job
             where jobname = 'swing-refresh-indices' and command like '%scope=indices%'),
           'scope=all here would re-fetch 36 equities every morning for three index values'
    union all
    select 'scheduling', 'the index catch-up runs every day, not only weekdays',
           case when (select count(*) from cron.job
                      where jobname = 'swing-refresh-indices' and schedule = '0 11 * * *') = 1
                then 'PASS' else 'FAIL' end,
           '1',
           coalesce((select schedule from cron.job where jobname = 'swing-refresh-indices'), '(absent)'),
           'Friday''s close is what a Saturday run collects; weekdays-only leaves the weekend stale'
    union all
    select 'scheduling', 'no scheduled command embeds a secret value',
           case when (select count(*) from cron.job
                      where command like '%NOT-A-KEY-ci-placeholder%') = 0
                then 'PASS' else 'FAIL' end,
           '0',
           (select count(*)::text from cron.job
             where command like '%NOT-A-KEY-ci-placeholder%'),
           'cron.job is readable by anyone who can read the database; it must store a lookup'
  ) t
),
-- ---------------------------------------------------------------------------
-- THE REGRESSION CLASS THAT CAUSED THE 2026-09-15 OUTAGE.
--
-- Every value check in this file passed on the day the dashboard and the digest both timed out,
-- because the numbers were right - they just took seven seconds to arrive, against an eight-second
-- statement timeout. A gate that only compares values cannot see that coming, and the fixture is
-- far too small for a timing gate to mean anything.
--
-- So these assert SHAPE, which is size-independent and is what actually went wrong: a join with no
-- equality in it (a "band join") has nothing to hash or merge on, so it pairs every row on one side
-- against every row on the other. Filtered to one date that costs 20 ms; over the whole view it
-- cost 7.2 s and removed 10.6 million rows by filter.
--
-- The first check is the invariant the equi-join REPLACING that band join depends on. If a symbol
-- could have a daily bar in a week with no weekly row, "the row before this week" and "the newest
-- week before this week" would stop being the same week, and the grid would silently show the
-- wrong week rather than fail. It cannot happen today - weekly_bars groups the same daily_bars -
-- but that is an argument, and this is a test.
-- ---------------------------------------------------------------------------
shape as (
  select * from (
    select 'shape'::text as section,
           'every week with a daily bar has a weekly row'::text as check_name,
           case when (select count(*) from (
                        select distinct f.symbol, date_trunc('week', f.d)::date as wk
                        from public.daily_features f) dw
                      where not exists (
                        select 1 from public.weekly_features w
                        where w.symbol = dw.symbol and w.week_start = dw.wk)) = 0
                then 'PASS' else 'FAIL' end as status,
           '0'::text as expected_v,
           (select count(*)::text from (
              select distinct f.symbol, date_trunc('week', f.d)::date as wk
              from public.daily_features f) dw
             where not exists (
               select 1 from public.weekly_features w
               where w.symbol = dw.symbol and w.week_start = dw.wk)) as actual_v,
           'a gap here would make grid_cells show the wrong week, silently - see 20260916060000'::text as note
    union all
    select 'shape', 'an unfiltered read of grid_cells needs no band join',
           case when pg_temp.plan_of(
                       'select max(d), count(distinct symbol) from public.grid_cells')
                     not like '%Join Filter%'
                then 'PASS' else 'FAIL' end,
           'no Join Filter',
           case when pg_temp.plan_of(
                       'select max(d), count(distinct symbol) from public.grid_cells')
                     not like '%Join Filter%'
                then 'no Join Filter' else 'Join Filter present' end,
           'this is the exact plan that timed out on 2026-09-15; an equality must be found, not a range'
    union all
    -- ---------------------------------------------------------------------------
    -- TWO COPIES OF THE VERDICT RULE, AND THE CHECK THAT KEEPS THEM EQUAL.
    --
    -- rs_cells (20260916140000) repeats grid_cells' below/normal/above CASE rather than sharing it,
    -- because a scalar function per cell is a per-row call the planner cannot see through. A copied
    -- rule that decides what COLOUR a cell is will drift, and nobody notices a wrong colour the way
    -- they notice a wrong number - so both are asserted against one reference expression written
    -- here, from the columns each view publishes. If either CASE changes, one of these fails.
    -- ---------------------------------------------------------------------------
    select 'shape', 'grid_cells verdicts match an independent re-derivation',
           case when (select count(*) from public.grid_cells c
                      where c.verdict is distinct from (
                        case when c.value is null or c.suppressed_warmup or not c.has_norm then null
                             when c.norm_low  is not null and c.value < c.norm_low  then 'below'
                             when c.norm_high is not null and c.value > c.norm_high then 'above'
                             else 'normal' end)) = 0
                then 'PASS' else 'FAIL' end,
           '0',
           (select count(*)::text from public.grid_cells c
             where c.verdict is distinct from (
               case when c.value is null or c.suppressed_warmup or not c.has_norm then null
                    when c.norm_low  is not null and c.value < c.norm_low  then 'below'
                    when c.norm_high is not null and c.value > c.norm_high then 'above'
                    else 'normal' end)),
           'the reference is deliberately the same shape for both views - drift in either shows up here'
    union all
    select 'shape', 'rs_cells verdicts match the SAME re-derivation, so the two cannot drift',
           case when (select count(*) from public.rs_cells c
                      where c.verdict is distinct from (
                        case when c.value is null or c.suppressed_warmup or not c.has_norm then null
                             when c.norm_low  is not null and c.value < c.norm_low  then 'below'
                             when c.norm_high is not null and c.value > c.norm_high then 'above'
                             else 'normal' end)) = 0
                then 'PASS' else 'FAIL' end,
           '0',
           (select count(*)::text from public.rs_cells c
             where c.verdict is distinct from (
               case when c.value is null or c.suppressed_warmup or not c.has_norm then null
                    when c.norm_low  is not null and c.value < c.norm_low  then 'below'
                    when c.norm_high is not null and c.value > c.norm_high then 'above'
                    else 'normal' end)),
           'RS has no warm-up, so suppressed_warmup is always false here - the arm is inert, not absent'
    union all
    -- The boundary itself. DEFINITIONS says a value EQUAL to a bound is inside the band - `<` and
    -- `>`, not `<=` and `>=` - and until the CI norms carried a bound equal to an actual fixture
    -- value, zero cells in either view sat on a boundary (measured: 0), so the two spellings were
    -- indistinguishable to every check here. This is the row that tells them apart.
    select 'shape', 'a value exactly on a norm bound is inside the band, not outside it',
           case when (select count(*) from public.rs_cells c
                      where c.value is not null and c.has_norm
                        and (c.value = c.norm_low or c.value = c.norm_high)
                        and c.verdict is distinct from 'normal') = 0
                    and (select count(*) from public.rs_cells c
                         where c.value is not null and c.has_norm
                           and (c.value = c.norm_low or c.value = c.norm_high)) > 0
                then 'PASS' else 'FAIL' end,
           '>=1 boundary cell, 0 misjudged',
           (select count(*)::text from public.rs_cells c
             where c.value is not null and c.has_norm
               and (c.value = c.norm_low or c.value = c.norm_high))
             || ' boundary cells, '
             || (select count(*)::text from public.rs_cells c
                  where c.value is not null and c.has_norm
                    and (c.value = c.norm_low or c.value = c.norm_high)
                    and c.verdict is distinct from 'normal')
             || ' misjudged',
           'the second clause is the point: zero boundary cells means this check proved nothing'
    union all
    -- ---------------------------------------------------------------------------
    -- FUNDS: a row on the grid, absent from breadth. Two exclusions, two flags (20260917060000).
    --
    -- The first check is what stops the other two being vacuous. If the fixture's fund had no
    -- history it would fall out of breadth because it is INELIGIBLE, not because it is a fund,
    -- and removing `not t.is_fund` from the view would not fail anything here.
    -- ---------------------------------------------------------------------------
    -- ---------------------------------------------------------------------------
    -- THE FIVE DERIVED TECHNICALS (20260917120000). Each is re-derived here from the columns
    -- daily_features publishes, independently of how daily_signals computes it.
    --
    -- The first check is the non-vacuity guard: a fixture with no crossing would let every cross
    -- assertion below pass over an empty set.
    -- ---------------------------------------------------------------------------
    -- Per cross type, and it has to be. The first version said `50_200 = 0 OR 21_50 = 0`, which the
    -- fixture satisfied entirely through 21/50 crossings while 50/200 had one per symbol - so the
    -- guard reported the checks were covered when half of them were not.
    select 'signals', 'the fixture contains crossings of EACH kind, so neither check is empty',
           case when (select count(*) from public.daily_signals where cross_50_200_bars = 0) > 0
                 and (select count(*) from public.daily_signals where cross_21_50_bars  = 0) > 0
                then 'PASS' else 'FAIL' end,
           'both > 0',
           (select count(*)::text from public.daily_signals where cross_50_200_bars = 0)
             || ' golden/death, ' ||
           (select count(*)::text from public.daily_signals where cross_21_50_bars = 0) || ' bull/bear',
           'an OR here lets one well-covered cross vouch for one that is not covered at all'
    union all
    select 'signals', 'ma_stack matches an independent re-derivation from the four inputs',
           case when (select count(*) from public.daily_signals s
                      join public.daily_features f on f.symbol = s.symbol and f.d = s.d
                      where s.ma_stack is distinct from (
                        case
                          when f.close is null or f.ema21_daily is null
                            or f.sma50 is null or f.sma200 is null then null
                          when f.close > f.ema21_daily and f.ema21_daily > f.sma50
                            and f.sma50 > f.sma200 then 'Full bull'
                          when f.close < f.ema21_daily and f.ema21_daily < f.sma50
                            and f.sma50 < f.sma200 then 'Full bear'
                          else 'Mixed' end)) = 0
                then 'PASS' else 'FAIL' end,
           '0',
           (select count(*)::text from public.daily_signals s
             join public.daily_features f on f.symbol = s.symbol and f.d = s.d
            where s.ma_stack is distinct from (
              case
                when f.close is null or f.ema21_daily is null
                  or f.sma50 is null or f.sma200 is null then null
                when f.close > f.ema21_daily and f.ema21_daily > f.sma50
                  and f.sma50 > f.sma200 then 'Full bull'
                when f.close < f.ema21_daily and f.ema21_daily < f.sma50
                  and f.sma50 < f.sma200 then 'Full bear'
                else 'Mixed' end)),
           'a strict chain both ways; anything else is Mixed, which is most rows and is not a fault'
    union all
    select 'signals', 'cross direction always agrees with the CURRENT ordering of the averages',
           case when (select count(*) from public.daily_signals s
                      join public.daily_features f on f.symbol = s.symbol and f.d = s.d
                      where s.cross_50_200 is distinct from (
                        case when f.sma50 is null or f.sma200 is null then null
                             when f.sma50 > f.sma200 then 'Golden' else 'Death' end)) = 0
                then 'PASS' else 'FAIL' end,
           '0',
           (select count(*)::text from public.daily_signals s
             join public.daily_features f on f.symbol = s.symbol and f.d = s.d
            where s.cross_50_200 is distinct from (
              case when f.sma50 is null or f.sma200 is null then null
                   when f.sma50 > f.sma200 then 'Golden' else 'Death' end)),
           'if sma50 is above sma200 the last cross WAS golden; a carried direction could disagree'
    union all
    -- The arithmetic, in two halves and over BOTH crosses.
    --
    -- This was one check with a `prev_bars is not null` guard, and the guard silently excluded the
    -- only rows that mattered: the fixture has exactly ONE 50/200 crossing per symbol, and on that
    -- bar there is no previous bars-since, so the reset-to-zero rule was never tested. An
    -- off-by-one mutation (`bar_no - last + 1`) passed the entire gate. It also only ever looked at
    -- 50/200; the 21/50 cross was untested. Both are fixed by asking the question directly.
    select 'signals', 'bars-since is exactly 0 on every bar where the label changed',
           case when (select count(*) from (
                        select c.*, lag(c.label) over w as prev_label
                        from public.signal_cells c
                        where c.param in ('cross_50_200','cross_21_50')
                        window w as (partition by c.symbol, c.param order by c.d)) x
                      where x.prev_label is not null and x.label is distinct from x.prev_label
                        and x.value is distinct from 0) = 0
                then 'PASS' else 'FAIL' end,
           '0',
           (select count(*)::text from (
              select c.*, lag(c.label) over w as prev_label
              from public.signal_cells c
              where c.param in ('cross_50_200','cross_21_50')
              window w as (partition by c.symbol, c.param order by c.d)) x
             where x.prev_label is not null and x.label is distinct from x.prev_label
               and x.value is distinct from 0),
           'the crossing bar is day zero; an off-by-one here shows as 1 and nowhere else'
    union all
    select 'signals', 'and advances by exactly 1 on every bar where it did not',
           case when (select count(*) from (
                        select c.*, lag(c.label) over w as prev_label,
                               lag(c.value) over w as prev_value
                        from public.signal_cells c
                        where c.param in ('cross_50_200','cross_21_50')
                        window w as (partition by c.symbol, c.param order by c.d)) x
                      where x.prev_label is not null and x.label is not distinct from x.prev_label
                        and x.prev_value is not null
                        and x.value is distinct from x.prev_value + 1) = 0
                then 'PASS' else 'FAIL' end,
           '0',
           (select count(*)::text from (
              select c.*, lag(c.label) over w as prev_label, lag(c.value) over w as prev_value
              from public.signal_cells c
              where c.param in ('cross_50_200','cross_21_50')
              window w as (partition by c.symbol, c.param order by c.d)) x
             where x.prev_label is not null and x.label is not distinct from x.prev_label
               and x.prev_value is not null
               and x.value is distinct from x.prev_value + 1),
           'BARS not calendar days, so a weekend must not advance it - decision 0035''s rule again'
    union all
    select 'signals', 'a null bars-since means NO cross in stored history, never a long time ago',
           case when (select count(*) from public.daily_signals s
                      where s.cross_50_200_bars is null
                        and exists (select 1 from public.daily_signals p
                                    where p.symbol = s.symbol and p.d < s.d
                                      and p.cross_50_200 is distinct from s.cross_50_200
                                      and p.cross_50_200 is not null)) = 0
                then 'PASS' else 'FAIL' end,
           '0',
           (select count(*)::text from public.daily_signals s
             where s.cross_50_200_bars is null
               and exists (select 1 from public.daily_signals p
                           where p.symbol = s.symbol and p.d < s.d
                             and p.cross_50_200 is distinct from s.cross_50_200
                             and p.cross_50_200 is not null)),
           'null here must mean the averages never swapped in the window we hold, not that we lost the event'
    union all
    select 'signals', 'both slopes match a fresh five-bar re-derivation',
           case when (select count(*) from (
                        select s.symbol, s.d, s.sma50_slope, s.sma200_slope,
                               100.0 * (f.sma50  / nullif(lag(f.sma50, 5)  over w, 0) - 1) as ref50,
                               100.0 * (f.sma200 / nullif(lag(f.sma200, 5) over w, 0) - 1) as ref200
                        from public.daily_signals s
                        join public.daily_features f on f.symbol = s.symbol and f.d = s.d
                        window w as (partition by f.symbol order by f.d)) x
                      where x.sma50_slope  is distinct from x.ref50
                         or x.sma200_slope is distinct from x.ref200) = 0
                then 'PASS' else 'FAIL' end,
           '0',
           (select count(*)::text from (
              select s.symbol, s.d, s.sma50_slope, s.sma200_slope,
                     100.0 * (f.sma50  / nullif(lag(f.sma50, 5)  over w, 0) - 1) as ref50,
                     100.0 * (f.sma200 / nullif(lag(f.sma200, 5) over w, 0) - 1) as ref200
              from public.daily_signals s
              join public.daily_features f on f.symbol = s.symbol and f.d = s.d
              window w as (partition by f.symbol order by f.d)) x
             where x.sma50_slope  is distinct from x.ref50
                or x.sma200_slope is distinct from x.ref200),
           'five TRADING BARS, and the change in the AVERAGE rather than in price'
    union all
    select 'signals', 'every label has a tone - the mapping is total, not mostly total',
           case when (select count(*) from public.signal_cells
                      where label is not null and tone is null) = 0
                then 'PASS' else 'FAIL' end,
           '0',
           (select count(*)::text from public.signal_cells where label is not null and tone is null),
           'a sixth signal added without a tone must fail the build, not render an unstyled cell'
    union all
    select 'signals', 'tone is not a norm verdict - nothing in norms can reach signal_cells',
           case when (select count(*) from public.signal_cells c
                      join public.norms n on n.param = c.param) = 0
                then 'PASS' else 'FAIL' end,
           '0',
           (select count(*)::text from public.signal_cells c
             join public.norms n on n.param = c.param),
           'if a norm key ever matched a signal param, editing norms.yml would silently restyle a chip'
    union all
    select 'shape', 'an unfiltered read of signal_cells needs no band join either',
           case when pg_temp.plan_of(
                       'select count(*), max(d) from public.signal_cells')
                     not like '%Join Filter%'
                then 'PASS' else 'FAIL' end,
           'no Join Filter',
           case when pg_temp.plan_of(
                       'select count(*), max(d) from public.signal_cells')
                     not like '%Join Filter%'
                then 'no Join Filter' else 'Join Filter present' end,
           'the 2026-09-16 outage class, checked on the newest view rather than only the old one'
    union all
    select 'shape', 'one date of daily_signals is an index scan, which is why it is a matview',
           case when pg_temp.plan_of(
                       'select * from public.daily_signals where d = (select max(d) from public.daily_signals)')
                     like '%Index%'
                then 'PASS' else 'FAIL' end,
           'index scan',
           case when pg_temp.plan_of(
                       'select * from public.daily_signals where d = (select max(d) from public.daily_signals)')
                     like '%Index%'
                then 'index scan' else 'sequential scan' end,
           'as a plain view the window would recompute the whole history on every dashboard load'
    union all
    -- ---------------------------------------------------------------------------
    -- A MATVIEW NOTHING REFRESHED. This project has now shipped that twice.
    --
    -- A materialized view is populated once, at CREATE time - which in CI is before the fixture
    -- loads, and in production is before any data exists. weekly_features shipped frozen in
    -- 20260914010000 and CI caught it; daily_signals shipped frozen in 20260917120000 and CI went
    -- GREEN, because every check that would have noticed was a check about something else.
    --
    -- So this one is generic. It asks pg_matviews what exists rather than naming them, because
    -- naming them means remembering to add the next one, and forgetting is the whole failure.
    -- ---------------------------------------------------------------------------
    select 'matviews', 'every materialized view has rows - none shipped frozen at create time',
           case when (select count(*) from pg_matviews
                      where schemaname = 'public'
                        and pg_temp.rows_in(format('%I.%I', schemaname, matviewname)) = 0) = 0
                then 'PASS' else 'FAIL' end,
           '0 empty',
           coalesce((select string_agg(matviewname, ', ' order by matviewname) from pg_matviews
                      where schemaname = 'public'
                        and pg_temp.rows_in(format('%I.%I', schemaname, matviewname)) = 0),
                    'none empty'),
           'an empty matview means run.sh (and probably the cron job) does not refresh it'
    union all
    select 'matviews', 'and the refresh job names every one of them',
           case when (select count(*) from pg_matviews m
                      where m.schemaname = 'public'
                        and not exists (
                          select 1 from cron.job j
                          where j.jobname = 'swing-refresh-features'
                            and j.command like '%' || m.matviewname || '%')) = 0
                then 'PASS' else 'FAIL' end,
           '0 unrefreshed',
           coalesce((select string_agg(m.matviewname, ', ' order by m.matviewname) from pg_matviews m
                      where m.schemaname = 'public'
                        and not exists (
                          select 1 from cron.job j
                          where j.jobname = 'swing-refresh-features'
                            and j.command like '%' || m.matviewname || '%')),
                    'all named'),
           'CI refreshing it by hand hides a production matview that nothing updates - 20260914010000'
    union all
    select 'funds', 'the fixture fund is breadth-ELIGIBLE, so excluding it actually costs something',
           case when (select count(*) from public.daily_features
                      where symbol = 'FUND' and sma200 is not null) > 0
                then 'PASS' else 'FAIL' end,
           '>0',
           (select count(*)::text from public.daily_features
             where symbol = 'FUND' and sma200 is not null),
           'a fund with no sma200 would leave breadth for the wrong reason and prove nothing below'
    union all
    -- Asserts over EVERY date rather than one. The first version picked `max(d) from
    -- market_context`, which is a date the INDEX series reaches and the companies do not - so it
    -- found zero funds there and failed, correctly. Picking a date is a way to be wrong; comparing
    -- the whole series is not.
    select 'funds', 'on every date, breadth_tracked is the company count - funds are not in it',
           case when (select count(*) from public.market_context m
                      where m.breadth_tracked is distinct from (
                        select count(*) from public.daily_features f
                        join public.tickers t on t.symbol = f.symbol
                        where t.active and not t.is_index and not t.is_fund and f.d = m.d)) = 0
                then 'PASS' else 'FAIL' end,
           '0 dates disagreeing',
           (select count(*)::text from public.market_context m
             where m.breadth_tracked is distinct from (
               select count(*) from public.daily_features f
               join public.tickers t on t.symbol = f.symbol
               where t.active and not t.is_index and not t.is_fund and f.d = m.d)) || ' disagree',
           'in production breadth_tracked is 43 companies, never the 53 rows the grid shows'
    union all
    select 'funds', 'and the fund has feature rows on dates breadth covers, so that costs something',
           case when (select count(*) from public.daily_features f
                      join public.tickers t on t.symbol = f.symbol
                      join public.market_context m on m.d = f.d
                      where t.active and t.is_fund and f.sma200 is not null) > 0
                then 'PASS' else 'FAIL' end,
           '>0 eligible fund-days inside the breadth window',
           (select count(*)::text from public.daily_features f
             join public.tickers t on t.symbol = f.symbol
             join public.market_context m on m.d = f.d
            where t.active and t.is_fund and f.sma200 is not null),
           'zero here means the check above is comparing a number to itself and proving nothing'
    union all
    select 'funds', 'a fund IS a grid row - that is the whole difference from an index',
           case when (select count(*) from public.grid_cells where symbol = 'FUND') > 0
                 and (select count(*) from public.grid_cells where symbol = '^IDX') = 0
                then 'PASS' else 'FAIL' end,
           'fund on the grid, index off it',
           (select count(*)::text from public.grid_cells where symbol = 'FUND') || ' fund cells, ' ||
           (select count(*)::text from public.grid_cells where symbol = '^IDX') || ' index cells',
           'overloading is_index to mean fund would delete ten rows from the grid, silently'
    union all
    select 'shape', 'market_cells verdicts match the SAME re-derivation - third copy, same rule',
           case when (select count(*) from public.market_cells c
                      where c.verdict is distinct from (
                        case when c.value is null or c.suppressed_warmup or not c.has_norm then null
                             when c.norm_low  is not null and c.value < c.norm_low  then 'below'
                             when c.norm_high is not null and c.value > c.norm_high then 'above'
                             else 'normal' end)) = 0
                then 'PASS' else 'FAIL' end,
           '0',
           (select count(*)::text from public.market_cells c
             where c.verdict is distinct from (
               case when c.value is null or c.suppressed_warmup or not c.has_norm then null
                    when c.norm_low  is not null and c.value < c.norm_low  then 'below'
                    when c.norm_high is not null and c.value > c.norm_high then 'above'
                    else 'normal' end)),
           'grid_cells, rs_cells and market_cells each spell this CASE out; all three answer to one reference'
    union all
    select 'shape', 'every market_cells value carries an as_of no later than its own day',
           case when (select count(*) from public.market_cells
                      where as_of is not null and as_of > d) = 0
                then 'PASS' else 'FAIL' end,
           '0',
           (select count(*)::text from public.market_cells where as_of is not null and as_of > d),
           'an as_of after the day it is shown on is look-ahead - the market block borrows, never predicts'
    union all
    select 'shape', 'rs_cells never warm-up-suppresses, because RS has no seed to decay',
           case when (select count(*) from public.rs_cells where suppressed_warmup) = 0
                then 'PASS' else 'FAIL' end,
           '0',
           (select count(*)::text from public.rs_cells where suppressed_warmup),
           'a true here would mean someone gave RS a warm-up floor without giving it a seed'
    union all
    select 'shape', 'rs_cells publishes no date the equities have not reached',
           case when (select count(*) from public.rs_cells c
                      where c.d > (select max(d) from public.daily_features)) = 0
                then 'PASS' else 'FAIL' end,
           '0',
           (select count(*)::text from public.rs_cells c
             where c.d > (select max(d) from public.daily_features)),
           'RS lags the grid by design; it must never LEAD it, which would mean an SPX bar from the future'
    union all
    select 'shape', 'grid_status does not read the weekly layer at all',
           case when pg_temp.plan_of('select * from public.grid_status')
                     not like '%weekly%'
                then 'PASS' else 'FAIL' end,
           'no weekly scan',
           case when pg_temp.plan_of('select * from public.grid_status')
                     not like '%weekly%'
                then 'no weekly scan' else 'weekly layer scanned' end,
           'the banner asks for a date and a symbol count; the dashboard asks for it on every revalidation'
  ) t
),
schedule_aware as (
  select * from (
    select 'staleness'::text as section,
           'flags.ingest_cron matches the scheduled job'::text as check_name,
           case
             -- Null means pg_cron is absent (every CI database). Skipped, not failed: asserting
             -- against a scheduler that is not installed would fail for the wrong reason.
             when pg_temp.scheduled_cron('swing-ingest-daily') is null then 'PASS'
             when pg_temp.scheduled_cron('swing-ingest-daily')
                  = (select value #>> '{}' from public.flags where key = 'ingest_cron') then 'PASS'
             else 'FAIL' end as status,
           coalesce((select value #>> '{}' from public.flags where key = 'ingest_cron'), 'unset')
             as expected_v,
           coalesce(pg_temp.scheduled_cron('swing-ingest-daily'), 'pg_cron absent, skipped')
             as actual_v,
           'the flag is what the rule reasons from; drift means the page judges against a schedule nothing runs on'::text as note

    -- ---- quiet when it should be quiet ------------------------------------
    union all
    select 'staleness', 'Sunday expects Friday''s fire, not an hour count',
           case when public.previous_scheduled_ingest('2026-09-20 21:45+00'::timestamptz, '30 22 * * 1-5', 60)
                     = '2026-09-18 22:30+00'::timestamptz then 'PASS' else 'FAIL' end,
           '2026-09-18 22:30+00',
           coalesce(public.previous_scheduled_ingest('2026-09-20 21:45+00'::timestamptz, '30 22 * * 1-5', 60)::text, 'null'),
           'the exact moment the old rule reported stale on a healthy pipeline: 47 hours, all of it weekend'
    union all
    select 'staleness', 'Monday before the fire still expects Friday',
           case when public.previous_scheduled_ingest('2026-09-21 12:00+00'::timestamptz, '30 22 * * 1-5', 60)
                     = '2026-09-18 22:30+00'::timestamptz then 'PASS' else 'FAIL' end,
           '2026-09-18 22:30+00',
           coalesce(public.previous_scheduled_ingest('2026-09-21 12:00+00'::timestamptz, '30 22 * * 1-5', 60)::text, 'null'),
           '61 hours after Friday and correctly silent - Monday''s run is not owed until the evening'
    union all
    select 'staleness', 'the grace window is respected',
           case when public.previous_scheduled_ingest('2026-09-21 22:35+00'::timestamptz, '30 22 * * 1-5', 60)
                     = '2026-09-18 22:30+00'::timestamptz then 'PASS' else 'FAIL' end,
           '2026-09-18 22:30+00',
           coalesce(public.previous_scheduled_ingest('2026-09-21 22:35+00'::timestamptz, '30 22 * * 1-5', 60)::text, 'null'),
           'five minutes after the fire the run is still running; without grace the page flashes stale every weekday'

    -- ---- loud when it should be loud ---------------------------------------
    union all
    select 'staleness', 'after Monday''s fire, a missed run is owed',
           case when public.previous_scheduled_ingest('2026-09-21 23:35+00'::timestamptz, '30 22 * * 1-5', 60)
                     = '2026-09-21 22:30+00'::timestamptz then 'PASS' else 'FAIL' end,
           '2026-09-21 22:30+00',
           coalesce(public.previous_scheduled_ingest('2026-09-21 23:35+00'::timestamptz, '30 22 * * 1-5', 60)::text, 'null'),
           'the case a fix for a false positive breaks by going quiet; this is what stops that'
    union all
    select 'staleness', 'a Friday success is stale by Tuesday',
           case when ('2026-09-18 22:45+00'::timestamptz
                      < public.previous_scheduled_ingest('2026-09-22 12:00+00'::timestamptz, '30 22 * * 1-5', 60))
                then 'PASS' else 'FAIL' end,
           'true',
           ('2026-09-18 22:45+00'::timestamptz
            < public.previous_scheduled_ingest('2026-09-22 12:00+00'::timestamptz, '30 22 * * 1-5', 60))::text,
           'Monday''s run never happened, so by Tuesday the last success predates the last owed fire'

    -- ---- declines rather than guessing --------------------------------------
    -- Asserted on the PURE form, which is why it exists: no test has to mutate public.flags and
    -- put it back, which is the kind of test that passes for the wrong reason.
    union all
    select 'staleness', 'an unparseable schedule declines instead of guessing',
           case when (select count(*) from (values
                        ('*/15 * * * *'), ('30 22 * * MON-FRI'), ('30 22 * * 1,3,5'),
                        ('99 99 * * 1-5'), ('garbage'), ('')
                      ) c(x)
                      where public.previous_scheduled_ingest('2026-09-20 21:45+00'::timestamptz, c.x, 60)
                            is not null) = 0
                then 'PASS' else 'FAIL' end,
           '0 of 6 guess',
           (select count(*)::text from (values
              ('*/15 * * * *'), ('30 22 * * MON-FRI'), ('30 22 * * 1,3,5'),
              ('99 99 * * 1-5'), ('garbage'), ('')
            ) c(x)
            where public.previous_scheduled_ingest('2026-09-20 21:45+00'::timestamptz, c.x, 60) is not null)
           || ' of 6 returned a fire',
           'a null reads as "cannot judge" in grid_status; inventing an alarm from a parse failure would be a second false positive'
    union all
    select 'staleness', 'a schedule it does understand is not declined',
           case when public.previous_scheduled_ingest('2026-09-20 21:45+00'::timestamptz, '30 22 * * 1-5', 60)
                     is not null then 'PASS' else 'FAIL' end,
           'not null',
           coalesce(public.previous_scheduled_ingest('2026-09-20 21:45+00'::timestamptz, '30 22 * * 1-5', 60)::text, 'null'),
           'the other half of the check above: declining everything would also pass it'
  ) t
),
all_rows as (
  select section, check_name, status, expected_v, actual_v, note from formula_rows
  union all
  select section, check_name, status, expected_v, actual_v, note from weekly_rows
  union all
  select section, check_name, status, expected_v, actual_v, note from degenerate
  union all
  select section, check_name, status, expected_v, actual_v, note from shape
  union all
  select section, check_name, status, expected_v, actual_v, note from schedule_aware
)
select * from (
  select 0 as ord, * from all_rows
  union all
  select 1, 'SUMMARY', count(*) filter (where status <> 'PASS')::text || ' of ' || count(*)::text
         || ' checks not passing',
         case when count(*) filter (where status <> 'PASS') = 0 then 'PASS' else 'FAIL' end,
         count(*)::text || ' checks',
         count(*) filter (where status = 'PASS')::text || ' passed',
         'CI fails the build unless this row says PASS'
    from all_rows
) s
order by ord, status, section, check_name;
