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
