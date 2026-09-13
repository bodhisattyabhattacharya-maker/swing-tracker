-- 20260913183000_cron_daily.sql
-- Purpose:    the daily clock. Two pg_cron jobs - fetch the bars, then rebuild daily_features -
--             which together are now the ENTIRE data pipeline, because there is no user-led
--             refresh (v1 scope decision, 2026-09-13). If these do not fire, the dashboard is
--             stale and nobody can do anything about it from the page.
-- Depends on: pg_cron 1.6.4 and pg_net, both already installed; the `ingest` edge function; the
--             `service_role_key` secret in Vault; daily_features (20260913064000).
-- Grants:     none. cron.schedule runs as `postgres`, which is the only role that can read Vault.
-- Reversing:  select cron.unschedule(jobid) from cron.job where jobname like 'swing-%';
--             Nothing else is touched - no data, no structure.
--
-- ---------------------------------------------------------------------------
-- WHY 22:30 UTC, AND WHY THAT IS NOT A DAYLIGHT-SAVING BUG
--
-- pg_cron 1.6 has no per-job timezone; jobs run in the server timezone, which is UTC here. A
-- fixed UTC time therefore lands on two different local times across the year:
--     22:30 UTC = 18:30 ET in EDT (summer)  = 17:30 ET in EST (winter)
-- Both are comfortably after the 16:00 ET close plus the vendor's 15-minute delay, so the last
-- daily bar is SETTLED rather than partial. That is the property that matters - not hitting a
-- particular wall-clock minute - so one fixed UTC entry is correct year-round and needs no DST
-- logic to get wrong. The alternative (month-guarded duplicate schedules) buys nothing and adds
-- a thing that breaks quietly in March and November.
--
-- Day-of-week 1-5 is also unambiguous here: at 22:30 UTC the US date is still the same weekday.
--
-- WHY THE REFRESH IS A SEPARATE JOB, 15 MINUTES LATER
-- Chaining it to the ingest would guarantee it only runs on fresh data, but it would couple two
-- failures into one silence: an ingest killed by the wall clock would leave the matview untouched
-- with no independent signal. Separate jobs mean a failed ingest still lets the refresh run, and
-- the freshness check in scripts/verify_parameters.sql reports the gap honestly. Two visible
-- failures beat one silent one. 15 minutes is enormous margin against a ~5 s run, and margin is
-- free.
--
-- WHAT THESE JOBS DO NOT TELL YOU - read this before trusting a green cron log:
--   pg_net's http_post is FIRE AND FORGET. It queues a request and returns an id immediately, so
--   `cron.job_run_details` records SUCCESS as soon as the request is QUEUED - not when the ingest
--   succeeded, and not even when the HTTP call completed. A cron success means "we asked", which
--   is the exact distinction this project keeps getting hurt by (INCIDENTS.md: a deploy toggle
--   that deployed nothing, a merged PR that applied no migration, a revoke that revoked nothing).
--
--   The real signals, in order of authority:
--     1. public.ingest_runs   - one row per run, with per-symbol counts and errors.
--     2. the freshness check  - scripts/verify_parameters.sql compares max(d) in daily_features
--                               against max(d) in daily_bars.
--     3. cron.job_run_details - only says the schedule fired.
--
-- NO RETRY, DELIBERATELY. One run a day, and a failure means a stale day. A second evening run
-- was offered and not taken; re-running would have been safe, since the upsert key is (symbol, d)
-- and the whole pipeline is idempotent. The compensating control is that staleness is VISIBLE on
-- the dashboard rather than silent - which is a requirement on the grid, not an optional nicety.
-- ---------------------------------------------------------------------------

-- Idempotent by name: re-running this migration, or editing a schedule later, must not leave a
-- duplicate job quietly firing alongside the new one. Unscheduling by a SELECT over cron.job
-- matches zero rows harmlessly on a first run, where cron.unschedule('name') would error.
select cron.unschedule(jobid) from cron.job where jobname in ('swing-ingest-daily', 'swing-refresh-features');

-- ---------------------------------------------------------------------------
-- 1. Fetch the bars.
--
-- No ?full=1 and no ?limit=: the incremental path asks each provider for the last 35 days, which
-- covers a long weekend, a missed run, or a week of outage several times over. planLimit() then
-- defaults to 45 symbols, so the whole 39-symbol watchlist completes in one run (~5 s measured
-- 2026-09-13) with headroom for tickers we add later.
--
-- The key is read from Vault at fire time and never stored in the schedule: cron.job.command
-- holds this query text, which contains a Vault LOOKUP, not a secret. That matters - this repo is
-- public and cron.job is readable by anyone who can read the database.
-- ---------------------------------------------------------------------------
select cron.schedule(
  'swing-ingest-daily',
  '30 22 * * 1-5',
  $job$
  select net.http_post(
    url     := 'https://qxngsbehqbcxnyyllalh.supabase.co/functions/v1/ingest?scope=all&by=cron-daily',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                      where name = 'service_role_key'),
      'Content-Type', 'application/json'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $job$
);

-- ---------------------------------------------------------------------------
-- 2. Rebuild the parameter layer.
--
-- CONCURRENTLY, which is why daily_features carries a unique index on (symbol, d). Without it the
-- refresh takes an ACCESS EXCLUSIVE lock and every dashboard reader blocks - or worse, waits and
-- then renders. With it, readers keep seeing the previous contents until the new ones are ready.
-- Verified 2026-09-13 that this is permitted inside a transaction block, which pg_cron requires.
--
-- If this ever fails, it fails loudly in cron.job_run_details, because unlike the ingest above it
-- is real SQL running inline rather than an HTTP request being queued.
-- ---------------------------------------------------------------------------
select cron.schedule(
  'swing-refresh-features',
  '45 22 * * 1-5',
  $job$ refresh materialized view concurrently public.daily_features; $job$
);
