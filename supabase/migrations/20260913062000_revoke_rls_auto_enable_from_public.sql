-- 20260913062000_revoke_rls_auto_enable_from_public.sql
-- Purpose:    actually stop unauthenticated callers reaching public.rls_auto_enable().
--             Migration 20260913061500 tried and failed. This is the corrective one.
-- Depends on: 20260913061500 (which is kept, unedited - migrations are forward-only).
-- Used by:    nothing of ours. The auto-RLS event trigger is unaffected, see below.
-- Reversing:  `grant execute on function public.rls_auto_enable() to public;`
--
-- WHY THE PREVIOUS MIGRATION DID NOTHING - the trap, written out so nobody repeats it:
--   20260913061500 ran `revoke execute ... from anon, authenticated` and succeeded. The advisor
--   still flagged the function afterwards, and the ACL explained why:
--
--       proacl = {=X/postgres, postgres=X/postgres}
--
--   The entry with an EMPTY grantee - `=X/postgres` - is a grant to **PUBLIC**. PostgreSQL grants
--   EXECUTE to PUBLIC automatically when a function is created, and `anon` / `authenticated`
--   inherit from PUBLIC rather than holding a grant of their own. So revoking from those two
--   roles removed privileges they never had, while the real grant sat untouched. The migration
--   reported success and changed nothing.
--
--   Generalise it: for functions, check `proacl` for a leading `=`, not just for role names. A
--   revoke that names roles individually is almost always the wrong shape for a default grant.
--   INCIDENTS.md 2026-09-13.
--
-- WHY REVOKE RATHER THAN TURN THE FEATURE OFF:
--   The project's "Enable automatic RLS" option created this function and an event trigger that
--   enables RLS on every new table. We could disable the option entirely - our own migrations
--   enable RLS explicitly anyway (20260912120000's header says so deliberately). We keep it:
--   with several contributors it is a genuine safety net for a table someone creates without
--   thinking, and the schema is public. Keep the net, close the door.
--
-- WHY THIS DOES NOT BREAK THE FEATURE:
--   The event trigger runs as its own owner (a Supabase superuser role), and superusers bypass
--   privilege checks entirely. Only the REST route disappears. If automatic RLS ever stops
--   working on a new table, this migration is the first place to look - check the trigger owner.

do $$
begin
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rls_auto_enable'
  ) then
    -- `from public` is the whole point of this migration. Do not "tidy" it into role names.
    revoke execute on function public.rls_auto_enable() from public;
    raise notice 'revoked execute on public.rls_auto_enable() from PUBLIC';
  else
    raise notice 'public.rls_auto_enable() not present; nothing to revoke';
  end if;
end
$$;
