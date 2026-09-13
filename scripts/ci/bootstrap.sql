-- scripts/ci/bootstrap.sql
--
-- Prepares a bare PostgreSQL 16 instance so the project's migrations can be applied to it. Used by
-- the CI job, and by anyone wanting to reproduce the whole verification locally in one command -
-- which is the point. Every migration in this project has been applied to a throwaway instance
-- before its PR was opened; this file is that practice made repeatable instead of remembered.
--
-- WHAT A BARE POSTGRES LACKS that our migrations assume, and how each is handled:
--
--   `service_role`        Supabase's client role. Created for real - the grants in the migrations
--                         are part of what we want to verify, so a stub would defeat the purpose.
--
--   pg_cron, pg_net       Both are Supabase extensions that cannot be installed here, and neither
--                         does anything we want to test. Stubbed so the scheduling migrations
--                         PARSE and APPLY - which catches a syntax error or a bad dollar-quote -
--                         while doing nothing. What the stubs deliberately do NOT prove is that
--                         pg_cron accepts the schedule strings or fires at the right minute. Only
--                         production answers that.
--
--   vault                 Holds the service_role key in production. Stubbed with a value that is
--                         obviously not a key, so if a migration ever embedded a secret into a
--                         cron command the CI output would show this placeholder rather than
--                         something real - and a test asserts that the stored command contains a
--                         lookup, not a value.
--
-- The stubs live here rather than in a migration because they must never reach production. A
-- migration that created a fake `cron` schema would be a genuine hazard; this file is only ever
-- run against a throwaway database.

-- The Supabase role set. Created for real, not stubbed: the grants and revokes in the migrations
-- are part of what this gate verifies, and a migration that revokes from `anon` is only meaningful
-- if `anon` exists. `authenticated` and `anon` inherit from PUBLIC exactly as they do in
-- production, which is what makes the "revoke from anon is a no-op" lesson (INCIDENTS.md,
-- 2026-09-13) reproducible here rather than only in production.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;

-- ---------------------------------------------------------------------------
-- pg_cron stand-in. cron.schedule records the job; cron.unschedule removes it. Enough for the
-- scheduling migrations to apply, and enough to assert they are idempotent on re-run.
-- ---------------------------------------------------------------------------
create schema cron;

create table cron.job (
  jobid    bigserial primary key,
  jobname  text,
  schedule text,
  command  text,
  active   boolean not null default true
);

create function cron.schedule(job_name text, sched text, cmd text) returns bigint
language sql as $$
  insert into cron.job (jobname, schedule, command) values ($1, $2, $3) returning jobid
$$;

create function cron.unschedule(id bigint) returns boolean
language sql as $$ delete from cron.job where jobid = $1 returning true $$;

-- ---------------------------------------------------------------------------
-- pg_net stand-in. Returns a request id and makes no request - which is exactly right for CI:
-- a scheduling migration must never cause an outbound call from a test run, least of all one
-- that could send email.
-- ---------------------------------------------------------------------------
create schema net;

create function net.http_post(
  url text, headers jsonb, body jsonb, timeout_milliseconds integer
) returns bigint language sql as $$ select 1::bigint $$;

-- ---------------------------------------------------------------------------
-- Vault stand-in. The value is deliberately not key-shaped.
-- ---------------------------------------------------------------------------
create schema vault;

create view vault.decrypted_secrets as
  select 'service_role_key'::text as name,
         'NOT-A-KEY-ci-placeholder'::text as decrypted_secret;
