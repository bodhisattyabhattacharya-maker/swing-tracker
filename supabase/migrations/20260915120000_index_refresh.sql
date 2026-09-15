-- 20260915120000_index_refresh.sql
-- Purpose:    a second, index-only ingest each morning, and a view that makes index freshness
--             visible rather than assumed. Prerequisite for the market-context parameters.
-- Depends on: the `indices` scope on the ingest function (same PR), pg_cron, pg_net, the
--             service_role_key secret in Vault, daily_bars, tickers, ingest_runs.
-- Grants:     select on index_status to service_role. cron.schedule runs as `postgres`.
-- Reversing:  select cron.unschedule(jobid) from cron.job where jobname = 'swing-refresh-indices';
--             drop view public.index_status; Nothing else is touched.
--
-- ---------------------------------------------------------------------------
-- WHY A SECOND RUN AT ALL
--
-- FRED publishes later than the 22:30 UTC ingest. Measured 2026-09-15: at the 22:30 run on Monday
-- 2026-09-14 every equity came back with Monday's bar, while ^VIX, ^VIX3M and ^GSPC stopped at
-- Friday 09-11. The index series are a full trading day behind the rest of the grid.
--
-- That is tolerable for a price and NOT tolerable for a VIX level. "VIX 16, calm" when yesterday it
-- spiked to 28 is the most believable kind of wrong, and market context is the next thing being
-- built on top of these series.
--
-- 11:00 UTC, EVERY DAY, and both parts of that are deliberate:
--   * 11:00 UTC is 07:00 ET - after any overnight publication, and hours before the next session,
--     so the previous close is in place before anyone looks at the dashboard during US hours.
--   * Every day rather than weekdays, because Friday's close is what a Saturday run collects. A
--     weekday-only schedule would leave the weekend showing Thursday.
--
-- THE HOUR IS A STARTING POINT, NOT A MEASUREMENT, and this file should say so. FRED's actual
-- publication time could not be derived from the data we hold: the only clean observation is that
-- Friday's ^VIX arrived at the Monday 22:30 run, and every other index row came from one backfill,
-- which tells us nothing about a daily rhythm. So 11:00 is chosen to be comfortably late rather
-- than tight, and `index_status` below exists to let us tighten it once a week of real runs has
-- accumulated. Guessing a tighter hour from two data points is how a threshold gets tuned to noise.
--
-- WHY NOT JUST MOVE THE MAIN RUN LATER: 22:30 was chosen so the equity bar is settled year-round
-- across both DST shifts (20260913183000). Moving it to suit FRED would trade a solved problem for
-- an unsolved one.
--
-- WHAT THIS DOES NOT FIX: if FRED has not published day d's value by 22:30 on day d - which is what
-- we currently observe - then the grid's row for day d still carries an index value from d-1 at the
-- moment it is built. The morning run closes that gap for every later reader, and `index_status`
-- reports the gap honestly meanwhile. Market context must therefore carry its own as-of date rather
-- than borrowing the grid's. That is the fallback behaviour, by design, not an oversight.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- index_status: how far behind the index series are, per symbol and overall.
--
-- Its whole job is to make a silent lag loud. Without it, "is the VIX current?" is a question you
-- have to think to ask, and the answer is only ever discovered when a number looks wrong.
-- ---------------------------------------------------------------------------
create view public.index_status as
with idx as (
  select t.symbol,
         max(b.d) as data_through,
         max(b.ingested_at) as last_ingested_at
  from public.tickers t
  left join public.daily_bars b on b.symbol = t.symbol
  where t.active and t.is_index
  group by t.symbol
),
eq as (
  -- The comparison that matters is not against the calendar - a market holiday is not a failure,
  -- the same reasoning as grid_status (decision 0026). It is against the EQUITIES, which share the
  -- same trading calendar and are known to arrive same-evening.
  select max(b.d) as equities_through
  from public.daily_bars b
  join public.tickers t on t.symbol = b.symbol
  where t.active and not t.is_index
)
select
  idx.symbol,
  idx.data_through,
  eq.equities_through,
  -- Trading days behind, counted in BARS rather than calendar days, so a weekend reads as 0.
  (select count(*)
     from (select distinct b.d
             from public.daily_bars b
             join public.tickers t on t.symbol = b.symbol
            where t.active and not t.is_index
              and b.d > idx.data_through) x)                      as trading_days_behind,
  idx.last_ingested_at,
  (idx.data_through >= eq.equities_through)                       as current
from idx cross join eq
order by idx.symbol;

comment on view public.index_status is
  'How far the FRED index series lag the equities, measured in trading days rather than calendar '
  'days so a weekend or holiday reads as zero. `current` false is normal for a few hours after the '
  'close and a problem if it persists past the 11:00 UTC catch-up. Market context reads its as-of '
  'date from here rather than assuming the grid''s date. See 20260915120000.';

grant select on public.index_status to service_role;

-- ---------------------------------------------------------------------------
-- The job. Idempotent by name, like the others: re-running this migration must not leave a
-- duplicate firing alongside the new one.
--
-- Three FRED calls. The key is read from Vault at fire time and never stored in the schedule -
-- cron.job.command holds this query text, and this repo is public.
-- ---------------------------------------------------------------------------
select cron.unschedule(jobid) from cron.job where jobname = 'swing-refresh-indices';

select cron.schedule(
  'swing-refresh-indices',
  '0 11 * * *',
  $job$
  select net.http_post(
    url     := 'https://qxngsbehqbcxnyyllalh.supabase.co/functions/v1/ingest?scope=indices&by=cron-indices',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                      where name = 'service_role_key'),
      'Content-Type', 'application/json'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $job$
);

-- A reminder that outlives this migration: a green row in cron.job_run_details means pg_net QUEUED
-- the request. Whether three index bars actually arrived is in `public.ingest_runs` where
-- scope = 'indices', and whether they were the RIGHT ones is `public.index_status`.
