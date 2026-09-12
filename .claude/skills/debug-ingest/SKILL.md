---
name: debug-ingest
description: Diagnose a failed or stale data ingest, or run one by hand. Use when data looks old, a run failed, a parameter is missing or implausible, or a new ticker needs backfilling.
---

# Debug or run an ingest

**Do not write a local fetch script.** This sandbox has no network route to any market-data
provider, nor to `*.supabase.co` — see `docs/CONSTRAINTS.md`. Everything runs inside Supabase.

## Read the evidence first

```sql
select id, scope, triggered_by, started_at, finished_at, ok, rows_written,
       detail->'daily'->'errors'  as daily_errors,
       detail->'hourly'->'errors' as hourly_errors,
       detail->'daily'->'deferred' as deferred,
       detail->>'fatal' as fatal
from ingest_runs order by started_at desc limit 10;
```

- `finished_at` null → the function died mid-run (wall clock, crash). Check the function logs.
- `ok=false` with per-symbol `errors` → those symbols only; the rest of the run is good.
- `fatal` set → watchlist fetch/parse failed; nothing was synced (by design, see `watchlist.ts`).
- `deferred` non-empty → the full-range cap was hit; run again (below) until it is empty.

## Narrow it down

- **All tickers failing** → endpoint shape or egress. Test one symbol with `net.http_get` from SQL.
- **One ticker failing** → delisted, renamed, or a bad symbol in `watchlist.yml`.
- **Data present but wrong** → not ingest. Go to `docs/DEFINITIONS.md`; check formula and warm-up.

## Run it by hand (from the SQL editor or an in-session `execute_sql` — a hard stop: confirm first)

```sql
select net.http_post(
  url     := 'https://<project-ref>.supabase.co/functions/v1/ingest?scope=all&by=<your-name>',
  headers := jsonb_build_object(
    'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                    where name = 'service_role_key'),
    'Content-Type', 'application/json'),
  body    := '{}'::jsonb,
  timeout_milliseconds := 150000
) as request_id;
-- then, after a minute:
select status_code, left(content::text, 2000) from net._http_response
 where id = <request_id>;
```

Useful variants: `&scope=tickers` (sync only), `&symbols=MU,NVDA`, `&full=1` (force full range),
`&limit=4` (fewer full fetches per call if the wall clock is tight).

## Afterwards

Yahoo is unofficial and breaks without warning. When it does: `docs/CONSTRAINTS.md` with the
date, then `docs/INCIDENTS.md`, then the fix. Before declaring it fixed, confirm one ticker
end to end: a run row with `ok=true` and a fresh `max(d)` in `daily_bars` for that symbol.
