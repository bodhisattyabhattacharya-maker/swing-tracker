-- 20260913061500_revoke_rls_auto_enable.sql
-- Purpose:    stop the anon and authenticated roles from calling Supabase's auto-RLS helper.
-- Depends on: nothing of ours. `public.rls_auto_enable()` is created by the project's
--             "Enable automatic RLS" option, which was ticked at project creation (SETUP.md).
-- Used by:    an event trigger, which runs as the table owner and is unaffected by this.
-- Reversing:  grant execute back. No data is touched.
--
-- WHY - found by Supabase's own security advisor, 2026-09-13:
--   `public.rls_auto_enable()` is SECURITY DEFINER and lives in the exposed `public` schema, so
--   it is callable by anyone as `POST /rest/v1/rpc/rls_auto_enable` with only the anon key. Our
--   anon key is compiled into a public browser bundle by design, and this repository is public,
--   so "anyone" is the correct reading of that.
--
--   The function enables RLS rather than disabling it, so the realistic blast radius is small.
--   That is not the point. A SECURITY DEFINER function reachable by unauthenticated callers is a
--   privilege-escalation shape, and the cost of closing it is one line. We do not keep an open
--   door because we have looked at it once and judged the room boring - the next reader would
--   have to repeat that judgement, and the function's body is not ours to depend on.
--
--   Note this is a GRANT on a function we did not write and do not own the definition of. If a
--   future Supabase change recreates it, the grant may come back; the advisor will say so again.
--   Check with: select p.proname, p.prosecdef, array_to_string(p.proacl, ' | ')
--                 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--                where n.nspname = 'public' and p.proname = 'rls_auto_enable';

-- `if exists` because the function only exists while the project's automatic-RLS option is on,
-- and a fresh project created without it must still be able to run this migration.
do $$
begin
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rls_auto_enable'
  ) then
    revoke execute on function public.rls_auto_enable() from anon, authenticated;
    raise notice 'revoked execute on public.rls_auto_enable() from anon, authenticated';
  else
    raise notice 'public.rls_auto_enable() not present; nothing to revoke';
  end if;
end
$$;
