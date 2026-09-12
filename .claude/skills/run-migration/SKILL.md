---
name: run-migration
description: Create or apply a database migration. Use when the schema needs to change — new table, column, index, view or function.
---

# Migrations

**Applying a migration is a hard stop.** Under the GitHub integration (decision 0016), "apply"
means "merge the PR" — a human merging to `main` is the confirmation. Never apply a migration
by any other route (MCP, CLI, dashboard SQL editor) without an explicit in-session yes, because
the integration tracks what it has applied and a side-channel apply causes a version conflict.

1. Migrations are **forward-only** and timestamp-named. Never edit one that has been merged —
   write a new one.
2. Create the file under `supabase/migrations/` as `<YYYYMMDDHHMMSS>_<short_description>.sql`.
   Use the current UTC time. Timestamps sort, so "numbered" still holds.
3. Open with the purpose header from `docs/CODE_STYLE.md` — purpose, depends on, used by,
   security, reversing. CI rejects a migration without at least three header lines.
4. **Enable RLS on every new table** in the same migration, even though the project's
   `ensure_rls` trigger does it automatically — intent should survive a project recreate.
   The repo is public, so the schema is public, so deny-by-default is the only safe start.
5. **Grant nothing by default.** Default anon/authenticated privileges are revoked
   (migration 20260912120000). If the dashboard must read a table, grant `select` and write
   the RLS policy in the same migration, and say why in the header.
6. If the migration changes how a parameter is computed, update `docs/DEFINITIONS.md` in the
   same PR and re-run the golden values.
7. Open the PR. CI validates the header. A human merges. Supabase applies it.
8. **Verify it applied**: Supabase dashboard → Database → Migrations, or `make context` once
   that is wired. Do not assume.
