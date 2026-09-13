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
    select 'scheduling', 'all three jobs registered exactly once',
           case when (select count(*) from cron.job where jobname like 'swing-%') = 3
                then 'PASS' else 'FAIL' end,
           '3',
           (select count(*)::text from cron.job where jobname like 'swing-%'),
           'a re-applied migration must not leave duplicates firing alongside the new ones'
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
all_rows as (
  select section, check_name, status, expected_v, actual_v, note from formula_rows
  union all
  select section, check_name, status, expected_v, actual_v, note from weekly_rows
  union all
  select section, check_name, status, expected_v, actual_v, note from degenerate
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
