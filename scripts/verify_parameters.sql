-- scripts/verify_parameters.sql
--
-- WHAT THIS IS: the integrity check for the parameter layer. It answers one question - "do the
-- numbers on the dashboard match the numbers on TradingView, and are they internally coherent?"
-- - and answers it in rows, not in prose, so nobody has to squint at a result set to decide.
--
-- HOW TO RUN IT, today: paste the whole file into the Supabase SQL editor and read the output.
-- Every row is a check. A run is good when, and only when, every row says PASS.
--
--     status    meaning
--     PASS      the check ran and held
--     FAIL      the check ran and did not hold - stop and read the note
--     MISSING   the row this check needs does not exist, so nothing was verified
--
-- MISSING is deliberately NOT the same as PASS. The single most expensive class of bug in this
-- project so far has been "a successful operation that changed nothing" - a deploy toggle that
-- was off, a migration that never applied, a revoke that revoked nothing (INCIDENTS.md). A check
-- that quietly verifies zero rows is that bug wearing a green tick. So a golden whose row is
-- absent reports MISSING loudly, and the usual cause is the first thing to try:
--
--     refresh materialized view public.daily_features;
--
-- This file is a single SELECT on purpose. It contains no DDL and writes nothing, so it runs
-- unchanged in the SQL editor, through a read-only connection, and in CI. When the CI harness
-- lands (a Postgres service container, an open task), the gate is: run this file, fail the build
-- if any row comes back with status <> 'PASS'. Nothing in the file needs to change for that - the
-- gate is a wrapper, and deliberately not baked in here, because a `raise exception` at the
-- bottom would hide the table that tells you WHICH check failed.
--
-- WHY THE GOLDEN VALUES ARE WHAT THEY ARE: they were read off TradingView by hand for MU on
-- 2026-09-04 and recorded in DEFINITIONS.md section 6. They are the only external anchor this
-- project has. Every formula here - Wilder's smoothing, the seeding, the frame width, the
-- inclusive volume average - was chosen to reproduce them, and they caught the provider switch
-- from Yahoo to Polygon being harmless (all four survived to within 1.5e-4). Do not "fix" a
-- golden because a formula change made it fail. The failing formula is the bug.
--
-- A note on tolerance: 1e-3 absolute. Observed agreement across providers was 2.4e-5 to 1.5e-4,
-- so this leaves an order of magnitude of headroom, while the error it exists to catch - a simple
-- rolling mean instead of Wilder's - is 9.4 RSI POINTS wide. There is no tolerance that admits
-- the second error and excludes the first; this one is nowhere near the line.
--
-- A note on drift: the recursive indicators are seeded from the EARLIEST bar we store, so a
-- deeper backfill shifts their seeds and could in principle move a golden. It does not in
-- practice, and the reason is measured: RSI computed from 490 bars agreed with the golden
-- computed from 2,529 to 8.6e-5. Wilder's smoothing forgets its seed geometrically. If a golden
-- ever starts failing right after a backfill, check the magnitude before assuming a formula bug -
-- a shift of 1e-5 is convergence, a shift of 1e-1 is not.

with
-- ---------------------------------------------------------------------------
-- 1. GOLDEN VALUES. The external anchor: hand-read from TradingView, MU, 2026-09-04.
--    DEFINITIONS.md section 6 holds the provenance and the cross-provider re-verification.
-- ---------------------------------------------------------------------------
golden(check_name, symbol, on_date, col, expected_value, tolerance) as (
  values
    ('golden MU RSI(14) daily', 'MU', date '2026-09-04', 'rsi_daily',  60.146789::double precision, 1e-3::double precision),
    ('golden MU EMA(21) daily', 'MU', date '2026-09-04', 'ema21_daily', 943.558105::double precision, 1e-3::double precision),
    ('golden MU SMA(50) daily', 'MU', date '2026-09-04', 'sma50',       938.279600::double precision, 1e-3::double precision),
    ('golden MU SMA(200) daily','MU', date '2026-09-04', 'sma200',      606.479549::double precision, 1e-3::double precision),
    -- Not from TradingView: MU's peak intraday high, reported independently as 1255.00 by both
    -- Yahoo and Polygon. Pinned AS OF a fixed date so it stays a constant - max_high_to_date is
    -- cumulative to the row, so this value cannot move when MU makes a new high tomorrow.
    ('golden MU peak high to 2026-09-04', 'MU', date '2026-09-04', 'max_high_to_date', 1255.00::double precision, 0.01::double precision)
),
golden_actual as (
  select
    g.check_name, g.symbol, g.on_date, g.expected_value, g.tolerance,
    case g.col
      when 'rsi_daily'        then f.rsi_daily
      when 'ema21_daily'      then f.ema21_daily
      when 'sma50'            then f.sma50
      when 'sma200'           then f.sma200
      when 'max_high_to_date' then f.max_high_to_date
    end as actual_value,
    -- Distinguishes "the row is absent" from "the row is there and the value is null", which are
    -- different problems: a missing refresh versus an indicator still inside its warm-up.
    (f.symbol is null) as row_absent,
    f.bars_available
  from golden g
  left join public.daily_features f
    on f.symbol = g.symbol and f.d = g.on_date
),
golden_rows as (
  select
    'golden'::text as section,
    check_name,
    case
      when row_absent then 'MISSING'
      when actual_value is null then 'FAIL'
      when abs(actual_value - expected_value) <= tolerance then 'PASS'
      else 'FAIL'
    end as status,
    to_char(expected_value, 'FM999999990.000000') as expected,
    coalesce(to_char(actual_value, 'FM999999990.000000'), '(null)') as actual,
    case
      when row_absent
        then 'no daily_features row for ' || symbol || ' on ' || on_date ||
             ' - refresh the matview, or check the ingest actually stored that date'
      when actual_value is null
        then 'row exists but the value is null - bars_available = ' ||
             coalesce(bars_available::text, '?') || ', so this is a warm-up or a null close'
      -- No FM prefix here: PostgreSQL rejects 'FM...EEEE' as incompatible, and this branch only
      -- runs when a check actually fails, so the error would have surfaced on the worst day.
      else 'diff ' || trim(to_char(abs(actual_value - expected_value), '0.000EEEE')) ||
           ' against tolerance ' || trim(to_char(tolerance, '0.000EEEE'))
    end as note
  from golden_actual
),

-- ---------------------------------------------------------------------------
-- 2. INVARIANTS. Things that must be true of every row, whatever the market did.
--    Each one is written as "count the rows that VIOLATE it", so the expected answer is always
--    zero and a new violation can never hide inside an average.
-- ---------------------------------------------------------------------------
counts as (
  select
    (select count(*) from public.daily_bars)                                              as bars,
    (select count(*) from public.daily_features)                                          as feats,
    (select count(distinct symbol) from public.daily_bars)                                as bar_symbols,
    (select count(distinct symbol) from public.daily_features)                             as feat_symbols,
    (select max(d) from public.daily_bars)                                                as bars_max_d,
    (select max(d) from public.daily_features)                                            as feats_max_d,
    -- Source data sanity. These are the bars every parameter is built on; if one is impossible,
    -- every number downstream is fiction. Checked here rather than only at ingest because the
    -- 1,164 quarterly-bars-labelled-daily rows of 2026-09-13 got in through a path that looked
    -- like it was working (INCIDENTS.md).
    (select count(*) from public.daily_bars
      where high is not null and low is not null and high < low)                          as bad_hl,
    (select count(*) from public.daily_bars
      where high is not null and close > high)                                            as bad_close_high,
    (select count(*) from public.daily_bars
      where low is not null and close < low)                                              as bad_close_low,
    (select count(*) from public.daily_bars where close <= 0)                             as bad_close,
    (select count(*) from public.daily_bars where d > current_date)                        as future_bars,
    -- Range and sign checks on the derived columns.
    (select count(*) from public.daily_features
      where rsi_daily is not null and (rsi_daily < 0 or rsi_daily > 100))                 as rsi_out_of_range,
    (select count(*) from public.daily_features
      where realized_vol_20 is not null and realized_vol_20 < 0)                          as neg_vol,
    (select count(*) from public.daily_features
      where volume_ratio is not null and volume_ratio <= 0)                               as bad_vol_ratio,
    -- Close can never exceed the running maximum of intraday highs, nor sit below the running
    -- minimum of lows. A violation means the extremes are being computed over the wrong frame -
    -- which is what a `range` frame instead of `rows` would produce.
    (select count(*) from public.daily_features
      where pct_off_high_stored is not null and pct_off_high_stored > 1e-9)                as close_above_max,
    (select count(*) from public.daily_features
      where pct_above_low_stored is not null and pct_above_low_stored < -1e-9)             as close_below_min,
    -- Warm-up. For the moving averages this is exact in BOTH directions: null before the window
    -- fills, never null after. "Not null too early" publishes a number that is still mostly its
    -- own seed, which is the failure mode constraint 8 exists for; "null too late" silently
    -- throws away rows the grid should be showing.
    --
    -- RSI gets a ONE-directional check, and that asymmetry is deliberate rather than an
    -- oversight: a genuinely flat 14-bar stretch has zero average gain AND zero average loss,
    -- where RSI is undefined and this layer returns null on purpose. Demanding "never null after
    -- bar 15" would make a halted or illiquid name look like a bug.
    (select count(*) from public.daily_features
      where bars_available < 15 and rsi_daily is not null)                                 as rsi_warmup_late,
    (select count(*) from public.daily_features
      where (bars_available >= 21) <> (ema21_daily is not null))                          as ema_warmup,
    (select count(*) from public.daily_features
      where (bars_available >= 50) <> (sma50 is not null))                                as sma50_warmup,
    (select count(*) from public.daily_features
      where (bars_available >= 200) <> (sma200 is not null))                              as sma200_warmup,
    -- The seed-decay flags are what hard constraint 8 is enforced through at the display layer,
    -- so they have to agree with the floors in DEFINITIONS.md section 4 - 125 bars for RMA(14),
    -- 97 for EMA(21). Asserted here as well as set in the migration, because the whole point of
    -- a flag is that a reader trusts it without re-deriving it.
    (select count(*) from public.daily_features
      where rsi_daily_seed_ok <> (bars_available >= 125))                                 as rsi_seed_flag,
    (select count(*) from public.daily_features
      where ema21_seed_ok <> (bars_available >= 97))                                      as ema_seed_flag,
    -- Informational, not a pass/fail: how many published rows are still seed-sensitive. If this
    -- is large, the grid is about to show a lot of blanks and that is worth knowing before
    -- someone reports it as a bug.
    (select count(*) from public.daily_features
      where rsi_daily is not null and not rsi_daily_seed_ok)                              as rsi_seed_sensitive,
    -- Every ticker we are actively tracking should have features. A ticker that ingested but
    -- produced no row is invisible on the grid, which looks like "no signal" rather than "no
    -- data" - the exact confusion this project is supposed to avoid.
    (select count(*) from public.tickers t
      where t.active
        and not exists (select 1 from public.daily_features f where f.symbol = t.symbol))  as tickers_without_features,
    -- The norms layer. The first two are the bugs that would be invisible on the page: a cell
    -- reading as judged-and-fine when nothing judged it, and a seed-influenced number being
    -- coloured anyway. Both would look completely normal to a human reading the grid.
    (select count(*) from public.grid_cells
      where verdict is not null and not has_norm)                                          as verdict_without_norm,
    (select count(*) from public.grid_cells
      where verdict is not null and suppressed_warmup)                                     as verdict_while_suppressed,
    (select count(*) from public.grid_cells
      where verdict is not null and verdict not in ('below','normal','above'))             as bad_verdict_value,
    -- Indices are market context, never grid rows.
    (select count(*) from public.grid_cells c
      join public.tickers t on t.symbol = c.symbol where t.is_index or not t.active)       as index_or_inactive_in_grid,
    -- Informational: a norm whose parameter does not exist yet. Expected to be 12 today and to
    -- FALL as the weekly, market and fundamental layers land. It cannot be an error - the
    -- parameters genuinely are not built - but a number that rises means a typo or a rename.
    (select count(*) from public.norms n
      where not exists (select 1 from public.grid_cells c where c.param = n.param))         as norms_without_parameter
),
invariant_rows as (
  select * from (
    select 'coverage'::text as section, 'every daily_bars row has a features row'::text as check_name,
           case when feats = bars then 'PASS' else 'FAIL' end as status,
           bars::text as expected, feats::text as actual,
           'a shortfall means rows were dropped by a join; an excess means duplicates'::text as note
      from counts
    union all
    select 'coverage', 'every symbol with bars has features',
           case when feat_symbols = bar_symbols then 'PASS' else 'FAIL' end,
           bar_symbols::text, feat_symbols::text,
           'a symbol present in daily_bars but absent from daily_features' from counts
    union all
    select 'coverage', 'every active ticker has features',
           case when tickers_without_features = 0 then 'PASS' else 'FAIL' end,
           '0', tickers_without_features::text,
           'active tickers with no feature rows at all - never ingested, or ingest failed silently' from counts
    union all
    -- The freshness check. A matview is a cache, and this is the row that catches the cache being
    -- stale - which is the normal state right after an ingest, because nothing refreshes it yet.
    select 'freshness', 'features are as current as the bars',
           case when feats_max_d is not distinct from bars_max_d then 'PASS' else 'FAIL' end,
           coalesce(bars_max_d::text, '(no bars)'), coalesce(feats_max_d::text, '(no features)'),
           'if these differ, run: refresh materialized view public.daily_features;' from counts
    union all
    select 'source data', 'no bar with high < low',
           case when bad_hl = 0 then 'PASS' else 'FAIL' end, '0', bad_hl::text,
           'impossible bar - a provider or mapping bug' from counts
    union all
    select 'source data', 'no close above its own high',
           case when bad_close_high = 0 then 'PASS' else 'FAIL' end, '0', bad_close_high::text,
           'impossible bar; would also corrupt every extreme' from counts
    union all
    select 'source data', 'no close below its own low',
           case when bad_close_low = 0 then 'PASS' else 'FAIL' end, '0', bad_close_low::text,
           'impossible bar; would also corrupt every extreme' from counts
    union all
    select 'source data', 'no non-positive close',
           case when bad_close = 0 then 'PASS' else 'FAIL' end, '0', bad_close::text,
           'a zero or negative close breaks every ratio and the log return' from counts
    union all
    select 'source data', 'no bar dated in the future',
           case when future_bars = 0 then 'PASS' else 'FAIL' end, '0', future_bars::text,
           'a timezone bug in the trading-date conversion looks exactly like this' from counts
    union all
    select 'ranges', 'RSI within 0..100',
           case when rsi_out_of_range = 0 then 'PASS' else 'FAIL' end, '0', rsi_out_of_range::text,
           'mathematically impossible - an arithmetic bug in the smoothing' from counts
    union all
    select 'ranges', 'realised volatility non-negative',
           case when neg_vol = 0 then 'PASS' else 'FAIL' end, '0', neg_vol::text,
           'a standard deviation cannot be negative' from counts
    union all
    select 'ranges', 'volume ratio positive',
           case when bad_vol_ratio = 0 then 'PASS' else 'FAIL' end, '0', bad_vol_ratio::text,
           'a non-positive ratio means a zero or negative average volume' from counts
    union all
    select 'look-ahead', 'close never above the running max high',
           case when close_above_max = 0 then 'PASS' else 'FAIL' end, '0', close_above_max::text,
           'the extremes frame is wrong, or a bar is impossible' from counts
    union all
    select 'look-ahead', 'close never below the running min low',
           case when close_below_min = 0 then 'PASS' else 'FAIL' end, '0', close_below_min::text,
           'the extremes frame is wrong, or a bar is impossible' from counts
    union all
    select 'warm-up', 'RSI(14) absent before 15 bars',
           case when rsi_warmup_late = 0 then 'PASS' else 'FAIL' end, '0', rsi_warmup_late::text,
           'a value published before its window exists is mostly its own seed' from counts
    union all
    select 'warm-up', 'EMA(21) present exactly from bar 21',
           case when ema_warmup = 0 then 'PASS' else 'FAIL' end, '0', ema_warmup::text,
           'off-by-one in the seed, in either direction' from counts
    union all
    select 'warm-up', 'SMA(50) present exactly from bar 50',
           case when sma50_warmup = 0 then 'PASS' else 'FAIL' end, '0', sma50_warmup::text,
           'off-by-one in the window frame' from counts
    union all
    select 'warm-up', 'SMA(200) present exactly from bar 200',
           case when sma200_warmup = 0 then 'PASS' else 'FAIL' end, '0', sma200_warmup::text,
           'off-by-one in the window frame' from counts
    union all
    select 'warm-up', 'RSI seed flag matches the 125-bar floor',
           case when rsi_seed_flag = 0 then 'PASS' else 'FAIL' end, '0', rsi_seed_flag::text,
           'the flag and DEFINITIONS.md section 4 disagree - hard constraint 8 is not being enforced' from counts
    union all
    select 'warm-up', 'EMA(21) seed flag matches the 97-bar floor',
           case when ema_seed_flag = 0 then 'PASS' else 'FAIL' end, '0', ema_seed_flag::text,
           'the flag and DEFINITIONS.md section 4 disagree - hard constraint 8 is not being enforced' from counts
    union all
    select 'norms', 'no verdict without a norm to judge by',
           case when verdict_without_norm = 0 then 'PASS' else 'FAIL' end, '0', verdict_without_norm::text,
           'a cell would read as judged-and-fine when nothing judged it - invisible on the page' from counts
    union all
    select 'norms', 'no verdict on a seed-suppressed value',
           case when verdict_while_suppressed = 0 then 'PASS' else 'FAIL' end, '0', verdict_while_suppressed::text,
           'hard constraint 8 - a value still carrying its seed must not be coloured' from counts
    union all
    select 'norms', 'verdict is one of below/normal/above',
           case when bad_verdict_value = 0 then 'PASS' else 'FAIL' end, '0', bad_verdict_value::text,
           'an unexpected verdict string would render as an unstyled cell' from counts
    union all
    select 'norms', 'no index or inactive ticker in the grid',
           case when index_or_inactive_in_grid = 0 then 'PASS' else 'FAIL' end, '0', index_or_inactive_in_grid::text,
           'indices are market context, not rows; inactive tickers left the watchlist' from counts
    union all
    -- Always PASS by construction. It is here because a count nobody looks at is a count nobody
    -- notices changing, and "why is half the grid blank" is a question this row answers instantly.
    select 'info', 'rows still seed-sensitive (suppress at display)',
           'PASS', '(informational)', rsi_seed_sensitive::text,
           'RSI values published with seed_ok = false; expected to be nonzero on a young series' from counts
    union all
    select 'info', 'norms with no parameter built yet',
           'PASS', '(informational)', norms_without_parameter::text,
           'expected 12 on 2026-09-13 and should FALL as layers land; a RISE means a typo or rename' from counts
  ) t
),
all_rows as (
  select * from golden_rows
  union all
  select * from invariant_rows
)
-- FAIL sorts before MISSING sorts before PASS, so the first rows on screen are the ones that
-- matter. The summary row is pinned to the bottom as the single line to read if you read nothing
-- else, and it is a row rather than a separate query so that one paste gives one answer.
select * from (
  select 0 as ord, section, check_name, status, expected, actual, note from all_rows
  union all
  select 1, 'SUMMARY',
         count(*) filter (where status <> 'PASS')::text || ' of ' || count(*)::text || ' checks not passing',
         case when count(*) filter (where status <> 'PASS') = 0 then 'PASS' else 'FAIL' end,
         count(*)::text || ' checks',
         count(*) filter (where status = 'PASS')::text || ' passed',
         'a run is good only when this row says PASS'
    from all_rows
) s
order by ord, status, section, check_name;
