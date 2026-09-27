-- 20260927220000_hourly_session.sql
-- Purpose:    session-aligned hourly bars, hourly RSI(14), and the `rsi_hourly` grid cell.
--             `hourly_session_bars` holds bars the ingest builds from one-minute aggregates
--             (supabase/functions/ingest/session.ts); `hourly_features` runs the SAME Wilder
--             recursion the daily and weekly layers use over them; `grid_cells` gains an hourly
--             branch. Two scheduled ingest jobs fill the table; the existing refresh job rebuilds
--             the matview.
-- Depends on: recursive_indicators (20260914010000), grid_cells (20260916060000), tickers,
--             daily_features (20260913064000), swing-refresh-features (20260918120000).
-- Grants:     select, insert, update on hourly_session_bars to service_role; select on
--             hourly_features to service_role. Nothing to anon or authenticated.
-- Reversing:  unschedule swing-ingest-hourly-a/-b; re-schedule swing-refresh-features from
--             20260918120000; restore grid_cells from 20260916060000; drop hourly_features, then
--             hourly_session_bars. hourly_bars is untouched here and needs nothing.
-- Decision:   0058.
--
-- ---------------------------------------------------------------------------
-- WHY A NEW TABLE RATHER THAN hourly_bars
--
-- `hourly_bars` (foundation) holds 13,936 rows of CLOCK-aligned hours - 09:00, 10:00 - with
-- extended-hours trading folded in, from the Yahoo era. They are not wrong so much as a different
-- instrument: TradingView's 1H bars start at the 09:30 open and exclude extended hours, and hourly
-- RSI read against 30/70 moves with which trades land in which bar. Writing session bars into the
-- same table would put two alignments under one primary key with nothing to tell them apart, and
-- an RSI computed across the seam would be neither.
--
-- So the new bars get their own table and the old one is left exactly as it is: nothing reads it,
-- nothing writes it, and dropping it is a separate, reversible-by-restore decision for later.
--
-- ---------------------------------------------------------------------------
-- WHY THERE IS NO NEW COPY OF WILDER'S SMOOTHING
--
-- The first draft of this migration copied `daily_recursive` into an `hourly_recursive` and added a
-- CI check that the two agreed. Reading 20260914010000 before writing it showed that was already
-- solved one level down: `recursive_indicators(date[], double precision[])` is the formula, written
-- once, timeframe-agnostic, and daily and weekly are thin wrappers over it. Hourly is a third
-- caller. There is nothing to drift.
--
-- It takes a `date[]` and echoes it back, and hours have timestamps. That is handled by NOT asking it
-- for the timestamp: it returns `bars_available` = the 1-based position in the series it was given,
-- which is joined back to the bar's own `row_number()` in the same `ts` order. Equality on
-- (symbol, position) - no band, no search. The dates passed in are each bar's ET trading date,
-- which is true, and is the only thing the function does with them.
--
-- ---------------------------------------------------------------------------
-- WHICH HOUR IS "THE DAY'S" HOURLY VALUE
--
-- The grid is keyed (symbol, day). The hourly cell for day d is RSI as of the bar that CLOSES d's
-- session - 15:30-16:00, or 12:30-13:00 on a half day - which the ingest marks `closes_session`.
--
-- Deliberately not "the newest bar stored for d". Those agree on every night the scheduled job runs,
-- and disagree exactly when something went wrong: a manual run mid-session stores 09:30 and 10:30,
-- and "newest" would publish the 10:30 RSI as the day's; a vendor gap at 15:30 would publish 14:30's.
-- Both are plausible numbers. With `closes_session`, both are a dash.
--
-- A partial unique index enforces at most one closing bar per (symbol, day) at WRITE time, so an
-- upsert that would create a second one - possible only if the early-close calendar changed under
-- stored data - fails for that symbol, loudly, in ingest_runs, rather than failing the whole refresh
-- later or silently picking one.
-- ---------------------------------------------------------------------------

create table public.hourly_session_bars (
  symbol          text             not null references public.tickers(symbol) on delete cascade,
  -- Bucket START, UTC. 13:30Z is the 09:30 EDT bar, 14:30Z the 09:30 EST one.
  ts              timestamptz      not null,
  -- ET trading date, stored rather than derived so the grid joins on it without timezone
  -- arithmetic in SQL - that arithmetic lives in session.ts, once, under test.
  d               date             not null,
  open            double precision,
  high            double precision,
  low             double precision,
  close           double precision not null,
  volume          bigint,
  -- One-minute bars that fed the bucket: 60, or 30 for 15:30-16:00. Anything less is evidence of
  -- a gap in the vendor's minutes (a halt, an outage), published rather than discarded.
  minutes         smallint         not null check (minutes between 1 and 60),
  closes_session  boolean          not null,
  source          text             not null,
  ingested_at     timestamptz      not null default now(),
  primary key (symbol, ts)
);

create index hourly_session_bars_symbol_d_idx on public.hourly_session_bars (symbol, d);

create unique index hourly_session_bars_one_close_per_day
  on public.hourly_session_bars (symbol, d) where closes_session;

comment on table public.hourly_session_bars is
  'Session-aligned hourly bars: 09:30-10:30 .. 14:30-15:30, then 15:30-16:00 (13:00 close on NYSE '
  'half days), extended hours excluded - TradingView''s 1H alignment. Built by the ingest from '
  'one-minute aggregates (session.ts). ts is the bucket start in UTC; d is the ET trading date. '
  'Supersedes hourly_bars. Decision 0058.';

alter table public.hourly_session_bars enable row level security;
-- Every table needs its grant stated; service_role has no default ACL here (20260913003000).
grant select, insert, update on table public.hourly_session_bars to service_role;

comment on table public.hourly_bars is
  'SUPERSEDED by hourly_session_bars (20260927220000, decision 0058). Clock-aligned hours with '
  'extended-hours trading, from the Yahoo era. Nothing reads or writes this table; it is kept '
  'only because dropping data is a separate decision.';

-- ---------------------------------------------------------------------------
-- hourly_features: RSI(14) on every stored hour.
--
-- 125 bars is the same seed floor the daily layer uses (rsi_daily_seed_ok): it is a property of
-- Wilder's smoothing forgetting its seed, not of the timeframe, so it is not re-argued here. On
-- hours it is about eighteen sessions, which the 90-day backfill clears several times over.
--
-- EMA(21) comes back from the shared function too and is deliberately not published. Nobody has
-- asked for an hourly EMA, and a column that exists gets read.
-- ---------------------------------------------------------------------------
create materialized view public.hourly_features as
with series as (
  select
    b.symbol,
    array_agg(b.d     order by b.ts) as ds,
    array_agg(b.close order by b.ts) as cs
  from public.hourly_session_bars b
  group by b.symbol
),
rec as (
  select s.symbol, r.bars_available, r.rsi14
  from series s
  cross join lateral public.recursive_indicators(s.ds, s.cs) r
),
numbered as (
  -- The SAME `order by ts` as the array_agg above. The join below is positional, so the two
  -- orderings must be one ordering; ts is the primary key, so there are no ties to break.
  select
    b.symbol, b.ts, b.d, b.close, b.minutes, b.closes_session,
    (row_number() over (partition by b.symbol order by b.ts))::integer as n
  from public.hourly_session_bars b
)
select
  n.symbol,
  n.ts,
  n.d,
  n.close,
  n.minutes,
  n.closes_session,
  r.rsi14                   as rsi_hourly,
  r.bars_available,
  (r.bars_available >= 125) as rsi_hourly_seed_ok
from numbered n
join rec r on r.symbol = n.symbol and r.bars_available = n.n;

-- Unique, which is what makes REFRESH ... CONCURRENTLY legal.
create unique index hourly_features_pk on public.hourly_features (symbol, ts);
-- The grid's join: one row per (symbol, day), and only the closing bar.
create index hourly_features_close_idx on public.hourly_features (symbol, d) where closes_session;

comment on materialized view public.hourly_features is
  'Wilder RSI(14) on session-aligned hourly bars, via recursive_indicators - the same function the '
  'daily and weekly layers call. closes_session marks the bar that ends the day''s session; the '
  'grid shows that one. Rebuilt by swing-refresh-features. Decision 0058.';

grant select on public.hourly_features to service_role;

-- ---------------------------------------------------------------------------
-- grid_cells: identical to 20260916060000 plus an `hourly_cells` branch.
--
-- EQUALITY ONLY, the rule the 2026-09-15 outage wrote: the one join is tickers on symbol, and the
-- closing-bar condition is a plain filter on hourly_features. The `shape` check in check_formulas.sql
-- asserts an unfiltered read of the whole view still has no Join Filter anywhere in its plan.
--
-- A day with no closing hour has no hourly row, like weekly's first week, and the page renders an
-- absent cell as a dash. The digest views filter to timeframe = 'daily', so hourly never reaches
-- the email - a CI check pins that too.
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
  -- Equality on the day's own week; `weekly_in_force` has already resolved which earlier week
  -- that week is showing (20260916060000).
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
hourly_cells as (
  -- From hourly_features directly, NOT joined through daily_features the way weekly is. Weekly
  -- needs the daily row to know which week a day is in; hourly carries its own trading date. The
  -- first draft joined through daily_features anyway "for consistency", and the planner answered
  -- with a nested loop and a redundant Join Filter on symbol - harmless at this size, and exactly the
  -- plan text the shape check exists to forbid. The join bought nothing: the page reads one date,
  -- `data_through`, which comes from daily_features already.
  select
    h.symbol,
    h.d,
    'rsi_hourly'::text   as param,
    h.rsi_hourly         as value,
    h.rsi_hourly_seed_ok as seed_ok,
    -- HOURS available, for the same reason weekly publishes weeks.
    h.bars_available,
    'hourly'::text as timeframe
  from public.hourly_features h
  join public.tickers t on t.symbol = h.symbol and t.active and not t.is_index
  where h.closes_session
),
cells as (
  select * from daily_cells
  union all
  select * from weekly_cells
  union all
  select * from hourly_cells
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
  'One row per (symbol, day, param): daily, weekly and hourly. A weekly param repeats its value '
  'across the days of a week and steps on the week boundary; the value shown on day d is from the '
  'newest week that started before d''s own week, so it can never see the future. The hourly param '
  'on day d is RSI as of the bar that closes d''s session, and is absent when that bar is. '
  '`timeframe` says which. Uncoloured (has_norm = false) is a normal state, not a missing threshold.';

-- ---------------------------------------------------------------------------
-- SCHEDULE. Before the daily ingest, so the existing 22:45 refresh picks both up together.
--
--   21:40  swing-ingest-hourly-a   hourly, even-numbered equities   (shard=0/2)
--   22:00  swing-ingest-hourly-b   hourly, odd-numbered equities    (shard=1/2)
--   22:30  swing-ingest-daily      unchanged
--   22:45  swing-refresh-features  now also rebuilds hourly_features
--   23:00  swing-digest            unchanged, and daily-only
--
-- 21:40 UTC is the earliest slot that clears the close in BOTH seasons with margin: 16:00 EST is
-- 21:00 UTC, the last bucket settles 15 minutes later (session.ts SETTLE_MS), and the job fires 25
-- minutes after that. In summer it is an hour later still.
--
-- TWO JOBS, because the per-run limit of 30 is a guess (provider.ts, HOURLY_LIMIT_INCREMENTAL): the
-- first hourly run in production is the first measurement there will be. Two shards of the 53
-- equities are 27 and 26, each inside 30, and `hourly_capacity` in ingest_test.ts parses this file
-- and fails if the watchlist outgrows shards x limit. Twenty minutes apart so the second cannot
-- overlap a first that runs to its 150 s wall clock.
--
-- SHARDS, NOT `offset`. The first draft used `limit=30&offset=30` for the second job. The ingest
-- sorts never-fetched symbols to the front of its plan on every run, so once job A had backfilled
-- some names the list job B offset into was a different list - on the first night it would have
-- skipped everything A had not reached. A shard is picked from the symbol list BEFORE planning, so
-- each symbol belongs to exactly one job whatever state it is in (provider.ts, parseShard).
--
-- THE FIRST NIGHT is the other trap: every equity has zero hourly bars, so every one plans a full
-- fetch. autoFullCap (provider.ts) holds a scheduled run to six of those and defers the rest,
-- visibly, instead of letting the wall clock kill it. Run the manual backfill in the runbook
-- (docs/DEFINITIONS.md / the PR) rather than waiting five nights for the schedule to get there.
--
-- Hourly is NOT folded into `scope=all` (decision 0058): an hourly top-up is roughly 200 times the
-- payload of a daily one, and the daily job's budget was measured without it.
--
-- Unschedule by name first, so re-applying this file replaces rather than duplicates. The key is a
-- Vault lookup at fire time, never a value - cron.job is readable by anyone who can read the
-- database, and this repo is public.
-- ---------------------------------------------------------------------------
select cron.unschedule(jobid) from cron.job
where jobname in ('swing-ingest-hourly-a', 'swing-ingest-hourly-b', 'swing-refresh-features');

select cron.schedule(
  'swing-ingest-hourly-a',
  '40 21 * * 1-5',
  $job$
  select net.http_post(
    url     := 'https://qxngsbehqbcxnyyllalh.supabase.co/functions/v1/ingest?scope=hourly&shard=0/2&by=cron-hourly',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                      where name = 'service_role_key'),
      'Content-Type', 'application/json'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $job$
);

select cron.schedule(
  'swing-ingest-hourly-b',
  '0 22 * * 1-5',
  $job$
  select net.http_post(
    url     := 'https://qxngsbehqbcxnyyllalh.supabase.co/functions/v1/ingest?scope=hourly&shard=1/2&by=cron-hourly',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                      where name = 'service_role_key'),
      'Content-Type', 'application/json'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $job$
);

-- hourly_features reads only hourly_session_bars, so its place in this list is free; it goes last
-- so the four existing lines stay in the order their own migrations argued for.
select cron.schedule(
  'swing-refresh-features',
  '45 22 * * 1-5',
  $job$
  refresh materialized view concurrently public.daily_features;
  refresh materialized view concurrently public.weekly_features;
  refresh materialized view concurrently public.daily_signals;
  refresh materialized view concurrently public.market_history;
  refresh materialized view concurrently public.hourly_features;
  $job$
);
