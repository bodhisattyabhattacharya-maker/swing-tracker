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
