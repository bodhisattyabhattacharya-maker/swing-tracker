-- 20260913200000_freshness_from_runs.sql
-- Purpose:    make the staleness judgment measure the PIPELINE rather than the calendar.
--             Replaces grid_status; no data or structure changes.
-- Depends on: grid_cells, ingest_runs, flags (20260913190000).
-- Used by:    the dashboard banner, and the email digest when it lands.
-- Reversing:  restore the previous definition from 20260913190000.
--
-- ---------------------------------------------------------------------------
-- WHAT WAS WRONG, AND WHY IT WOULD HAVE BEEN WORSE THAN NO BANNER
--
-- The first version asked "how many calendar days since the newest bar?" and called anything past
-- three stale. That tolerates a normal Friday-to-Monday gap exactly, which means it works until
-- the first public holiday: Friday's bar, a closed Monday, and Tuesday's check reads four days and
-- fires the banner on data that is perfectly healthy.
--
-- A banner that lies once gets ignored forever after. Since its entire job is to be believed on
-- the day something actually breaks - ten people read this page and none of them can refresh it -
-- a false positive is not a cosmetic bug, it is the failure of the feature.
--
-- THE FIX: ask about the pipeline, not the date gap.
--
--   Stale now means "the daily ingest has not completed successfully recently enough", measured in
--   hours against the schedule. That is the question we actually care about, and it happens to get
--   every calendar edge right for free:
--
--   | Situation                        | Newest bar | Last good run | Verdict |
--   |----------------------------------|-----------|---------------|---------|
--   | Ordinary Tuesday                  | yesterday | last night    | fresh   |
--   | Sunday                            | Friday    | Saturday 22:30| fresh   |
--   | Monday holiday, cron ran fine     | Friday    | last night    | fresh   |
--   | Cron failed last night            | yesterday | 2 nights ago  | STALE   |
--   | Cron has not run for a week       | old       | a week ago    | STALE   |
--
--   The market being closed no longer looks like a broken pipeline, and a broken pipeline is still
--   caught on the very next missed cycle.
--
-- `data_through` and `days_behind` are still published as FACTS, because "the newest bar we hold
-- is from Friday" is worth showing. They are just no longer the basis of the verdict.
--
-- WHY IT COUNTS ONLY RUNS THAT FETCHED BARS: a `scope=tickers` run syncs the watchlist and the
-- norms and reports ok=true without touching a single price. Counting it as evidence of freshness
-- would mean a config sync could mask a week of failed price ingests. The filter is on the run
-- having a `daily` section in its detail, which only the bar-fetching path writes.
-- ---------------------------------------------------------------------------

-- DROP then CREATE, not CREATE OR REPLACE. Replacing a view can add trailing columns but cannot
-- rename or reorder existing ones, and this changes `stale_after_days` to `stale_after_hours` -
-- PostgreSQL rejects that with "cannot change name of view column". Nothing depends on this view
-- inside the database (the web app resolves it by name at request time), so dropping it is safe;
-- if something ever does depend on it, this will fail loudly rather than silently cascade.
drop view if exists public.grid_status;

create view public.grid_status as
with cfg as (
  select
    -- Hours, not days: the schedule is daily, so the natural unit for "a cycle was missed" is
    -- hours, and a day-granular threshold cannot distinguish "ran late last night" from
    -- "did not run at all". 30 gives one full cycle plus six hours of slack for a slow run or a
    -- vendor publishing late. Edited in config/norms.yml like every other judgment.
    coalesce(
      (select (value #>> '{}')::numeric from public.flags where key = 'pipeline_stale_after_hours'),
      30
    ) as stale_after_hours
),
d as (
  select max(d) as data_through, count(distinct symbol) as symbols
  from public.grid_cells
),
-- The most recent run that actually fetched bars AND finished cleanly. Both conditions matter:
-- an unfinished run tells us nothing, and a failed one is the thing we are looking for.
good as (
  select max(finished_at) as last_success_at
  from public.ingest_runs
  where ok is true and finished_at is not null and detail ? 'daily'
),
-- Kept separate from `good` on purpose. The LAST run and the last GOOD run are different
-- questions, and showing both is what distinguishes "nothing has run" from "it ran and failed" -
-- which need different fixes.
latest as (
  select finished_at, ok, triggered_by
  from public.ingest_runs order by id desc limit 1
)
select
  d.data_through,
  d.symbols,
  (current_date - d.data_through)                                        as days_behind,
  good.last_success_at,
  round(extract(epoch from (now() - good.last_success_at)) / 3600.0, 1)  as hours_since_success,
  cfg.stale_after_hours,
  -- Null last_success_at means the daily ingest has never completed successfully. That is stale by
  -- any reading, and coalescing it to false would hide the one case where the page has never
  -- worked at all.
  coalesce(
    extract(epoch from (now() - good.last_success_at)) / 3600.0 > cfg.stale_after_hours,
    true
  )                                                                      as is_stale,
  latest.finished_at                                                     as last_run_at,
  latest.ok                                                              as last_run_ok,
  latest.triggered_by                                                    as last_run_by
from d cross join cfg cross join good left join latest on true;

comment on view public.grid_status is
  'One row: how current the grid is and whether the page should say so. is_stale measures the '
  'PIPELINE - hours since the daily ingest last completed successfully - not the gap to the newest '
  'bar, so a market holiday does not read as a failure. data_through and days_behind are published '
  'as facts but are not the verdict. last_run_ok and is_stale answer different questions: a run '
  'can succeed and the pipeline still be behind, and a config-only sync is deliberately not '
  'counted as evidence that prices arrived.';

grant select on public.grid_status to service_role;
