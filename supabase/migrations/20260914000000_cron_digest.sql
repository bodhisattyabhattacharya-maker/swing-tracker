-- 20260914000000_cron_digest.sql
-- Purpose:    schedule the weekday digest. This is the change that makes the system send email.
-- Depends on: the `digest` edge function (deployed and dry-run read on 2026-09-13), digest_changes,
--             digest_standing, and the Resend secrets on the function.
-- Grants:     none. cron.schedule runs as `postgres`, the only role that can read Vault.
-- Reversing:  select cron.unschedule(jobid) from cron.job where jobname = 'swing-digest';
--             That is also the kill switch. It takes effect immediately and loses nothing.
--
-- ---------------------------------------------------------------------------
-- 23:00 UTC, thirty minutes after the ingest and fifteen after the refresh.
--
-- The ordering is the point. The digest reads `digest_changes`, which reads `grid_cells`, which
-- reads the `daily_features` matview. If it ran before the refresh it would compare today's bars
-- against yesterday's parameters and report changes that had not happened.
--
--   22:30  swing-ingest-daily      fetch bars
--   22:45  swing-refresh-features  rebuild parameters
--   23:00  swing-digest            read and send
--
-- Fifteen minutes is enormous margin against a refresh that takes under nine seconds, and against
-- an ingest that takes five. Margin is free here; a race is not.
--
-- WHY THIS IS A SEPARATE MIGRATION FROM THE FUNCTION IT SCHEDULES: sending is irreversible. The
-- function shipped first, callable only by hand with `?send=0`, so a human could read the actual
-- email before anything could be sent to anyone. Only after that happened does this file exist.
-- That sequencing is the point, not ceremony.
--
-- IF THE INGEST FAILED, THE DIGEST STILL RUNS — deliberately. It reads `grid_status`, sees the
-- pipeline is stale, and sends a short notice saying so instead of a market summary. An email that
-- simply stops arriving is indistinguishable from a quiet market, which is the one thing this is
-- supposed to rule out. Suppressing the send on failure would recreate exactly that ambiguity.
--
-- WHAT A GREEN ROW HERE DOES NOT MEAN, for the fifth time on this project: pg_net's http_post is
-- fire-and-forget, so `cron.job_run_details` records SUCCESS when the request is QUEUED. Whether
-- an email was actually accepted by Resend is in `ingest_runs` where scope = 'digest', which
-- carries the provider's message id on success and the error text on failure.
-- ---------------------------------------------------------------------------

select cron.unschedule(jobid) from cron.job where jobname = 'swing-digest';

select cron.schedule(
  'swing-digest',
  '0 23 * * 1-5',
  $job$
  select net.http_post(
    url     := 'https://qxngsbehqbcxnyyllalh.supabase.co/functions/v1/digest?by=cron-digest',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                      where name = 'service_role_key'),
      'Content-Type', 'application/json'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $job$
);
