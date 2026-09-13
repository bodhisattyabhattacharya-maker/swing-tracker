-- 20260913003000_service_role_grants.sql
-- Purpose:    give the ingest identity (service_role) the table privileges it actually needs.
--             Without these the edge function 500s with "permission denied" - INCIDENTS.md
--             2026-09-13.
-- Depends on: 20260912120000_foundation (the four tables).
-- Used by:    supabase/functions/ingest, and every future fetcher using the service role.
-- Security:   anon and authenticated still get NOTHING. Dashboard reads arrive later as RLS
--             policies on a role that has been granted select deliberately, table by table.
-- Reversing:  revoke the same grants. No data is touched.
--
-- WHY THIS IS NEEDED AT ALL - the trap, stated plainly so nobody re-learns it:
--   Supabase's generous default privileges ("new tables are usable by anon/authenticated/
--   service_role") are attached to the `supabase_admin` role. A migration runs as `postgres`,
--   and default privileges are per-owner-role, so NONE of those apply to a table we create.
--   What `postgres` defaults do give service_role is the useless set `Dxtm` - TRUNCATE,
--   REFERENCES, TRIGGER, MAINTAIN - and no SELECT/INSERT/UPDATE/DELETE. Verified on the live
--   ACL: `service_role=Dxtm/postgres`. So: EVERY migration that creates a table must grant on
--   it explicitly (decision 0018). There is no default privilege doing this for you.

-- ---------------------------------------------------------------------------
-- select + insert + update, and deliberately NO DELETE.
--
-- The ingest function never deletes: a symbol dropped from watchlist.yml is set active=false
-- precisely because daily_bars cascades on delete and a one-line config edit must not erase
-- years of history (decision 0017). Withholding the privilege makes that promise enforceable
-- by Postgres rather than by a code review. If a future feature genuinely needs to delete
-- rows, it arrives as its own migration with its own reasoning - not as a blanket grant here.
-- ---------------------------------------------------------------------------
grant select, insert, update on table tickers      to service_role;
grant select, insert, update on table daily_bars   to service_role;
grant select, insert, update on table hourly_bars  to service_role;
grant select, insert, update on table ingest_runs  to service_role;

-- No grant on any sequence. `ingest_runs.id` is `generated always as identity`, and Postgres
-- performs the sequence advance internally for identity columns - unlike a `serial` column,
-- which would need USAGE on its sequence. If an insert ever fails on a sequence permission,
-- that assumption was wrong and belongs in INCIDENTS.md.
