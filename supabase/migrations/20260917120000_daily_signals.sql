-- 20260917120000_daily_signals.sql
-- Purpose:    the Technicals preset's five derived columns - moving-average stack, the two crosses
--             with bars-since, and the two slopes. Adds matview `daily_signals` and view
--             `signal_cells`, and puts the new matview in the refresh job.
-- Depends on: daily_features (20260913064000), tickers.
-- Grants:     select on daily_signals and signal_cells to service_role.
-- Reversing:  drop view public.signal_cells; drop materialized view public.daily_signals; and
--             re-schedule swing-refresh-features with only the two existing refreshes. No source
--             data is touched - everything here is derived from columns daily_features already has.
--
-- ---------------------------------------------------------------------------
-- NO NEW DATA. THE INPUTS HAVE BEEN SITTING IN daily_features SINCE 20260913064000.
--
-- `close`, `ema21_daily`, `sma50` and `sma200` are all published already; what the UI spec asks for
-- is what they say about each other. Five columns, no ingest change, no vendor:
--
--   ma_stack             Full bull / Full bear / Mixed
--   cross_sma50_sma200   Golden / Death, plus bars since it happened
--   cross_ema21_sma50    Bull / Bear, plus bars since
--   sma50_slope          Rising / Falling, plus percent per week
--   sma200_slope         same
--
-- The vendor sells SMA, EMA, MACD and RSI endpoints. NONE of these five is among them: an
-- indicator endpoint returns the average, and every column here is a statement ABOUT the averages.
-- Buying the inputs we already compute, and losing the 1e-9 formula gate that proves ours match an
-- independent implementation of Wilder's, would be a poor trade for code that is this file long.
--
-- ---------------------------------------------------------------------------
-- WHY A MATVIEW AND NOT A VIEW - the 2026-09-16 lesson, one step earlier
--
-- Every column here needs a WINDOW over each symbol's whole history: the slope looks back a week,
-- and "bars since the last cross" looks back as far as the last cross, which may be years.
--
-- A filter cannot pass through a window function. `where d = '2026-09-17'` on a view containing
-- `over (partition by symbol order by d rows unbounded preceding)` does NOT become an index lookup -
-- Postgres computes the window over the entire history and then throws almost all of it away. The
-- dashboard reads one date on every revalidation, so that is the whole history re-scanned per page
-- load: the same shape as the band join that took the site down, arriving by a different route.
--
-- A matview computes it once per day, and `daily_signals_pk` makes the one-date read an index scan.
-- The cost is one more thing to refresh - and this project has already shipped a matview that
-- nothing refreshed (weekly_features, caught by CI). The refresh job is amended at the bottom of
-- this file, and check_formulas.sql asserts the job names all three.
--
-- ---------------------------------------------------------------------------
-- DEFINITIONS PINNED HERE, because every one of them is a choice someone will otherwise re-guess
--
-- **Stack.** Full bull is `close > ema21 > sma50 > sma200`; Full bear is the exact reverse; anything
-- else is Mixed. Mixed is not a failure state - it is most of the time, and a chip that said
-- "Mixed" on 70% of rows is doing its job.
--
-- **Cross direction is read from the CURRENT side, not from a stored event.** If sma50 is above
-- sma200 today then the last cross was necessarily a Golden one. This is not a shortcut; it is the
-- same fact, and it removes an entire class of bug where the carried direction and the current
-- ordering disagree.
--
-- **Ordering is a strict `>`.** Exact float equality between two averages is not a third state, it
-- is a measure-zero event that would otherwise fork every comparison. `sma50 = sma200` reads as
-- "not above", and a cross is a change in that boolean.
--
-- **Bars, not days.** "Golden 88d" counts 88 TRADING BARS, not calendar days - the same rule
-- decision 0035 set for relative strength, and for the same reason: a calendar interval silently
-- spans a different number of sessions depending on where the weekends and holidays fall.
--
-- **Slope is a five-bar change in the average, as a percentage: `100 * (sma[t]/sma[t-5] - 1)`.**
-- Five trading bars is a week. It is the change in the AVERAGE, not in price - a 50-day average
-- moving +0.6% in a week is a statement about the trend of the trend.
--
-- **Direction is the sign, with no dead zone.** A slope of -0.04% reads "Falling" and displays as
-- -0.0%/wk, which is what the design shows. Inventing a "Flat" band would mean picking a width,
-- and any width is arbitrary. `Flat` is emitted only for exactly zero, which a real series
-- essentially never produces and a synthetic one does.
--
-- **The stack inherits ema21's warm-up; the crosses and slopes do not.** An EMA is partly its seed
-- until it has decayed (hard constraint 8), so an ordering that depends on it is untrustworthy for
-- the same window - `seed_ok` carries `ema21_seed_ok`. An SMA is exact the moment its window is
-- full: there is nothing to decay, so a cross between two SMAs has no seed state at all.
-- ---------------------------------------------------------------------------

create materialized view public.daily_signals as
with base as (
  select
    f.symbol,
    f.d,
    f.close,
    f.ema21_daily,
    f.ema21_seed_ok,
    f.sma50,
    f.sma200,
    -- Strict `>`; equality reads as "not above". See the header.
    (f.sma50 > f.sma200)      as fifty_above_two_hundred,
    (f.ema21_daily > f.sma50) as ema_above_fifty,
    row_number() over (partition by f.symbol order by f.d) as bar_no
  from public.daily_features f
  join public.tickers t on t.symbol = f.symbol
  -- Funds and companies both get technicals; an ETF has a 200-day average like anything else.
  -- Indices do not: they are context, never a row (decision 0041).
  where t.active and not t.is_index
),
flagged as (
  select
    b.*,
    lag(b.fifty_above_two_hundred) over w as prev_50_200,
    lag(b.ema_above_fifty)         over w as prev_21_50,
    -- The average five bars back. `lag(x, 5)` counts ROWS in this symbol's own series, which is
    -- what makes "per week" mean five sessions rather than seven days.
    lag(b.sma50, 5)                over w as sma50_5b,
    lag(b.sma200, 5)               over w as sma200_5b
  from base b
  window w as (partition by b.symbol order by b.d)
),
events as (
  select
    f.*,
    -- The bar number of a crossing, null on every other bar. `prev is not null` excludes the first
    -- bar of a symbol's history, where there is no previous side to have crossed from.
    case when f.prev_50_200 is not null and f.fifty_above_two_hundred is distinct from f.prev_50_200
         then f.bar_no end as event_50_200,
    case when f.prev_21_50 is not null and f.ema_above_fifty is distinct from f.prev_21_50
         then f.bar_no end as event_21_50
  from flagged f
),
carried as (
  select
    e.*,
    -- The most recent crossing at or before this bar. `max()` over a running frame works precisely
    -- because bar_no increases - it is the newest event, not the largest value coincidentally.
    max(e.event_50_200) over w as last_50_200_bar,
    max(e.event_21_50)  over w as last_21_50_bar
  from events e
  window w as (partition by e.symbol order by e.d rows between unbounded preceding and current row)
)
select
  c.symbol,
  c.d,

  -- ---- Moving-average stack ----------------------------------------------
  case
    when c.close is null or c.ema21_daily is null or c.sma50 is null or c.sma200 is null then null
    when c.close > c.ema21_daily and c.ema21_daily > c.sma50 and c.sma50 > c.sma200 then 'Full bull'
    when c.close < c.ema21_daily and c.ema21_daily < c.sma50 and c.sma50 < c.sma200 then 'Full bear'
    else 'Mixed'
  end                                                                   as ma_stack,
  -- The ordering is only as trustworthy as the EMA inside it.
  c.ema21_seed_ok                                                       as ma_stack_seed_ok,

  -- ---- SMA50 x SMA200 -----------------------------------------------------
  -- Direction from the CURRENT side. Null until both averages exist.
  case when c.fifty_above_two_hundred is null then null
       when c.fifty_above_two_hundred then 'Golden' else 'Death' end    as cross_50_200,
  -- Null means NO CROSS IN STORED HISTORY, which is a different fact from "crossed a long time
  -- ago" and must not render as a large number. Five years of data cannot see a 2019 cross.
  (c.bar_no - c.last_50_200_bar)                                        as cross_50_200_bars,

  -- ---- EMA21 x SMA50 ------------------------------------------------------
  case when c.ema_above_fifty is null then null
       when c.ema_above_fifty then 'Bull' else 'Bear' end               as cross_21_50,
  (c.bar_no - c.last_21_50_bar)                                         as cross_21_50_bars,
  -- Same warm-up caveat as the stack: this one has an EMA leg.
  c.ema21_seed_ok                                                       as cross_21_50_seed_ok,

  -- ---- Slopes, percent per five trading bars ------------------------------
  case when c.sma50_5b is not null and c.sma50_5b <> 0
       then 100.0 * (c.sma50 / c.sma50_5b - 1) end                      as sma50_slope,
  case when c.sma200_5b is not null and c.sma200_5b <> 0
       then 100.0 * (c.sma200 / c.sma200_5b - 1) end                    as sma200_slope

from carried c;

comment on materialized view public.daily_signals is
  'What the moving averages say about each other: stack ordering, the two crosses with BARS since '
  'each (not calendar days - decision 0035''s rule), and both slopes as percent per five trading '
  'bars. Derived entirely from daily_features; no new source. A matview rather than a view because '
  'every column needs a window over the symbol''s whole history and a date filter cannot pass '
  'through a window function - see 20260917120000. Refresh with swing-refresh-features.';

create unique index daily_signals_pk on public.daily_signals (symbol, d);
create index daily_signals_d_idx on public.daily_signals (d);

grant select on public.daily_signals to service_role;

-- ---------------------------------------------------------------------------
-- signal_cells: the same shape the grid reads everywhere else, adapted for CATEGORICAL values.
--
-- `grid_cells` publishes `value double precision` and a norm verdict. These five are chips, not
-- numbers judged against a band: "Golden 88d", "Full bull", "Rising +0.6%/wk". So this view
-- publishes a `label` and an OPTIONAL `value`, and instead of a verdict it publishes a `tone`.
--
-- **`tone` IS NOT A VERDICT, and the distinction is load-bearing.** A verdict says "this value is
-- outside a threshold you set" and comes from `norms`. A tone says "this category reads bullish or
-- bearish" and comes from the label itself - there is no threshold to cross and nothing in
-- config/norms.yml to edit. Rendering them with the same colours is a design choice the spec makes
-- deliberately; conflating them in the data would mean the norms sync could silently change a chip.
--
-- The mapping label -> tone is TOTAL: every label this view can emit has exactly one tone, and
-- check_formulas.sql asserts it, so adding a sixth signal without a tone fails the build rather
-- than rendering an unstyled cell.
-- ---------------------------------------------------------------------------
create view public.signal_cells as
select symbol, d, param, label, value, tone, seed_ok
from (
  select
    s.symbol, s.d,
    c.param, c.label, c.value, c.seed_ok,
    case
      when c.label is null                        then null::text
      when c.label in ('Full bull','Golden','Bull','Rising') then 'bull'
      when c.label in ('Full bear','Death','Bear','Falling') then 'bear'
      when c.label in ('Mixed','Flat')            then 'neutral'
    end as tone
  from public.daily_signals s
  cross join lateral ( values
      ('ma_stack'::text,           s.ma_stack,       null::double precision, s.ma_stack_seed_ok),
      ('cross_50_200'::text,       s.cross_50_200,   s.cross_50_200_bars::double precision, true),
      ('cross_21_50'::text,        s.cross_21_50,    s.cross_21_50_bars::double precision,
                                                     s.cross_21_50_seed_ok),
      ('sma50_slope'::text,
         case when s.sma50_slope is null then null
              when s.sma50_slope > 0 then 'Rising'
              when s.sma50_slope < 0 then 'Falling'
              else 'Flat' end,                      s.sma50_slope, true),
      ('sma200_slope'::text,
         case when s.sma200_slope is null then null
              when s.sma200_slope > 0 then 'Rising'
              when s.sma200_slope < 0 then 'Falling'
              else 'Flat' end,                      s.sma200_slope, true)
    ) c(param, label, value, seed_ok)
) t;

comment on view public.signal_cells is
  'The five derived technicals in cell shape - one row per (symbol, day, param) with a categorical '
  'label, an optional number and a tone. `tone` is NOT a norm verdict: it comes from the label, not '
  'from config/norms.yml, and nothing in the norms sync can change it. A null cross_*_bars means NO '
  'CROSS IN STORED HISTORY, which is not the same as a long time ago. See 20260917120000.';

grant select on public.signal_cells to service_role;

-- ---------------------------------------------------------------------------
-- THE REFRESH JOB. A matview nothing refreshes is frozen at the moment it was created, correct on
-- day one and silently a day staler every day after - which this project has already shipped once,
-- in weekly_features, and which CI caught rather than a human.
--
-- Re-scheduled by name so this REPLACES the job rather than adding a second one. The 22:45 slot is
-- unchanged.
--
-- ORDER MATTERS HERE, unlike the two existing refreshes. daily_signals reads daily_features, so a
-- stale daily_features would produce a stale-but-consistent daily_signals and nothing would look
-- wrong. weekly_features is a sibling of daily_features, not a child, which is why the previous
-- migration could say order did not matter and this one cannot.
-- ---------------------------------------------------------------------------
select cron.unschedule(jobid) from cron.job where jobname = 'swing-refresh-features';

select cron.schedule(
  'swing-refresh-features',
  '45 22 * * 1-5',
  $job$
  refresh materialized view concurrently public.daily_features;
  refresh materialized view concurrently public.weekly_features;
  refresh materialized view concurrently public.daily_signals;
  $job$
);
