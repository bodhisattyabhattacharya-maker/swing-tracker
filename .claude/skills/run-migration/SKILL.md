---
name: run-migration
description: Create or apply a database migration. Use when the schema needs to change — new table, column, index, view or function.
---

# Migrations

**Applying a migration is a hard stop. Confirm in-session first, every time.**

1. Migrations are **forward-only** and numbered. Never edit one that has been merged — write a
   new one.
2. Create the file under `supabase/migrations/` as `NNNN_short_description.sql`.
3. Enable RLS on every new table in the same migration. **This repo is public**, so the schema is
   visible; deny-by-default is the only safe starting point.
4. Test against a throwaway branch before touching the real project. CI does this on every PR.
5. If the migration changes how a parameter is computed, update `docs/DEFINITIONS.md` in the same
   PR and re-run the golden-value tests.
