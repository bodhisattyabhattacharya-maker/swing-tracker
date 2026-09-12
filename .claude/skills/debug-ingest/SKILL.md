---
name: debug-ingest
description: Diagnose a failed or stale data ingest. Use when data looks old, a nightly run failed, or a parameter is missing or implausible.
---

# Debug an ingest failure

**Do not write a local fetch script.** This sandbox has no network route to any market-data
provider — see `docs/CONSTRAINTS.md`. Everything runs inside Supabase.

1. Check `ingest_runs` first: last successful run, rows written, and the error payload.
2. Narrow it down:
   - **All tickers failing** → the endpoint changed shape, or egress broke. Test one symbol
     directly with `pg_net` from SQL.
   - **One ticker failing** → likely delisted, renamed, or a bad symbol in `watchlist.yml`.
   - **Data present but wrong** → not an ingest problem. Go to `docs/DEFINITIONS.md` and check
     the formula and warm-up floor.
3. Yahoo is unofficial and breaks without warning. When it does, record the new behaviour in
   `docs/CONSTRAINTS.md` with today's date, and add an `INCIDENTS.md` entry.
4. Before declaring it fixed, confirm the nightly smoke test passes for a single ticker
   end to end.
