-- 20260915060000_weekly_on_grid.sql
-- Purpose:    put the weekly parameters on the grid. Adds `weekly_asof`, widens `grid_cells` with
--             four weekly params and a `timeframe` column, and keeps weekly out of the digest.
-- Depends on: weekly_features (20260914010000), grid_cells / digest_changes / digest_standing
--             (20260913190000, 20260913230000), norms.
-- Grants:     select on weekly_asof to service_role. The replaced views keep their existing grants.
-- Reversing:  restore the previous bodies of grid_cells, digest_changes and digest_standing from
--             20260913190000 and 20260913230000, then drop weekly_asof. No data is touched and no
--             matview needs rebuilding - every object here is a plain view.
--
-- ---------------------------------------------------------------------------
-- THE ONLY HARD PART: WHICH WEEK A GIVEN DAY IS ALLOWED TO SEE
--
-- `grid_cells` is keyed on (symbol, DAY). `weekly_features` is keyed on (symbol, WEEK). Joining them
-- is where a backtest gets silently corrupted, so the rule is written out rather than inferred:
--
--     the weekly value shown on day d comes from the newest week that STARTED STRICTLY BEFORE
--     the week containing d.
--
--         week_start < date_trunc('week', d)
--
-- Two things follow, and both matter.
--
-- **It cannot leak the future.** Any week earlier than d's own week had certainly finished by d.
-- The week containing d had not - on Wednesday nobody knows Friday's close - so it is excluded by
-- construction. This is hard constraint 5 expressed as arithmetic instead of as a warning.
--
-- **It does NOT use `is_complete`, deliberately.** That flag means "not the newest week in the data
-- AS IT STANDS TODAY". It is a fact about now, not about d, so a backtest standing on 2024-03-05
-- that consulted it would be asking a question only the present can answer. The date comparison
-- above needs no market calendar, no flag, and gives the same answer whenever it is run - which is
-- what keeps parameters a pure function of (ticker, date) (decision 0002).
--
-- Consequence worth stating: the weekly columns are CONSTANT from Monday to Friday and step once,
-- on the week boundary. That is correct - a weekly bar has one value - and it is why the digest
-- deliberately ignores them; see the bottom of this file.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- weekly_asof: weekly_features plus the start of the NEXT week for that symbol, which turns the
-- "newest week before X" lookup into a range join instead of a correlated subquery per day.
--
-- Every week is included, the in-progress one too. It can never be selected: it would have to be
-- older than the week containing some daily bar, and there is no daily bar after it. Letting the
-- date arithmetic exclude it, rather than filtering on `is_complete`, is what keeps this view free
-- of any dependence on the present.
-- ---------------------------------------------------------------------------
create view public.weekly_asof as
select
  w.symbol,
  w.week_start,
  lead(w.week_start) over (partition by w.symbol order by w.week_start) as next_week_start,
  w.weeks_available,
  w.rsi_weekly,
  w.rsi_weekly_seed_ok,
  w.close_vs_ema21w,
  w.ema21w_seed_ok,
  w.close_vs_sma30w,
  w.close_vs_sma200w
from public.weekly_features w;

comment on view public.weekly_asof is
  'weekly_features with the next week_start alongside, so a daily row can range-join to the newest '
  'week that started before its own week. Includes the in-progress week, which the date rule can '
  'never select. See 20260915060000 for why this uses dates rather than the is_complete flag.';

grant select on public.weekly_asof to service_role;

-- ---------------------------------------------------------------------------
-- grid_cells gains the four weekly params and a `timeframe` column.
--
-- `timeframe` is appended LAST on purpose: `create or replace view` may add trailing columns but
-- may not rename or reorder existing ones, so this replaces the view in place and every dependent
-- (digest_changes, digest_standing, the dashboard's PostgREST reads) keeps working untouched.
--
-- It earns its place rather than being decoration: the digest filters on it, and a reader looking
-- at a blue cell needs to know whether it is describing today or the week before last.
--
-- WHAT IS NOT COLOURED, and why. `close_vs_sma200w` had a norm of 0..10 - "near long-term support
-- = interesting". Measured 2026-09-15 across every complete week we hold: **87-90% of name-weeks
-- sit above +10 in every year**, and only ~4% ever land inside the band. That is structural, not a
-- market phase. Distance above a four-year mean says how long the universe has been rising; it is
-- not a per-name signal, and a threshold that flags 9 rows in 10 is decoration rather than
-- judgment. The norm is removed in config/norms.yml and the column ships UNCOLOURED. `sma30w` has
-- no norm yet for the simpler reason that nobody has measured one. Both still show their value -
-- `has_norm = false` is exactly the state the grid already renders for twelve other parameters.
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
  join public.weekly_asof w
    on  w.symbol = f.symbol
    and w.week_start < date_trunc('week', f.d)::date
    and (w.next_week_start is null or w.next_week_start >= date_trunc('week', f.d)::date)
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
-- THE DIGEST STAYS DAILY.
--
-- Measured before this was written, over 88 weeks: if weekly params entered the digest, **every
-- weekly crossing in the watchlist would fire on the same Monday** - a mean of 11.6, 18 at p90, 26
-- at worst - because the as-of week steps for all 36 names at once. For comparison, the whole
-- daily digest of 2026-09-14 had ten lines.
--
-- Those crossings are real, but they are not news about Monday; they are the calendar turning over.
-- An email that reads as dramatic every Monday by construction is one you stop believing, which is
-- the failure decision 0027 exists to prevent. So the digest keeps reporting what crossed TODAY,
-- and weekly movement gets a treatment of its own once we have watched a few Mondays on the grid.
--
-- One predicate, easy to remove when that happens.
-- ---------------------------------------------------------------------------
create or replace view public.digest_changes as
with judged as (
  select
    c.symbol, c.param, c.d, c.value, c.verdict,
    lag(c.verdict) over (partition by c.symbol, c.param order by c.d) as prev_verdict,
    lag(c.value)   over (partition by c.symbol, c.param order by c.d) as prev_value,
    lag(c.d)       over (partition by c.symbol, c.param order by c.d) as prev_d,
    row_number()   over (partition by c.symbol, c.param order by c.d desc) as recency
  from public.grid_cells c
  where c.has_norm and c.timeframe = 'daily'
)
select
  symbol, param, d, prev_d, value, prev_value, prev_verdict, verdict,
  case
    when prev_verdict = 'normal' and verdict = 'below' then 'crossed below'
    when prev_verdict = 'normal' and verdict = 'above' then 'crossed above'
    when prev_verdict = any (array['below','above']) and verdict = 'normal' then 'back to normal'
    else prev_verdict || ' to ' || verdict
  end as movement,
  verdict = any (array['below','above']) as now_outside
from judged j
where recency = 1
  and prev_verdict is not null
  and verdict is not null
  and verdict is distinct from prev_verdict;

comment on view public.digest_changes is
  'Daily-timeframe crossings only. Weekly params are excluded deliberately: they step for the whole '
  'watchlist on the same Monday (measured: mean 11.6, worst 26), which is the calendar turning over '
  'rather than news. See 20260915060000.';

create or replace view public.digest_standing as
select c.symbol, c.param, c.value, c.verdict
from public.grid_cells c
where c.d = (select max(grid_cells.d) from public.grid_cells)
  and c.timeframe = 'daily'
  and c.verdict = any (array['below','above']);

comment on view public.digest_standing is
  'Standing daily-timeframe exceptions on the latest date. Weekly excluded for the same reason as '
  'digest_changes.';
