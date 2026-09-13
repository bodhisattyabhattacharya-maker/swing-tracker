# Incidents

One entry per bug or crash. Written **after** failing. Newest last.
For approaches that never worked in the first place, use `CONSTRAINTS.md`.

**Template**

```
## YYYY-MM-DD — <short symptom>
**Symptom:** what we actually saw.
**Root cause:** the real reason, not the first guess.
**Fix:** what changed.
**Earlier detection:** the check that would have caught this. Add it, or say why not.
```

---

## 2026-09-13 — ingest returned 401 to a genuine service_role key
**Symptom:** first three manual calls to the deployed `ingest` function (via `net.http_post`
from the SQL editor, bearer read from Vault) all came back `401 {"error":"unauthorized"}` —
the function's own response, so the gateway's JWT check had passed. `ingest_runs` empty.
**Root cause:** the function accepted a bearer only if it was byte-identical to the runtime's
`SUPABASE_SERVICE_ROLE_KEY` env var. The Vault value was verified to be a real service_role JWT
(219 chars, `role: service_role`, no whitespace), so the env var the runtime injects is not the
legacy key shown on the dashboard's API Keys page. Nothing in the repo can inspect that env var,
which made the design unverifiable, not just wrong. (Call 1 was a separate, real mistake: the
anon key had been stored in Vault. The lock held, correctly.)
**Fix:** `auth.ts` — accept a bearer whose JWT payload says `role: service_role` (signature
already verified by the gateway, `verify_jwt = true`), OR a byte match with the env var. Tests
cover anon-refused, service_role-accepted-regardless-of-env, non-JWT byte match.
**Earlier detection:** a fixture test cannot see the runtime env, so no. What would have: a
smoke call as part of the first deploy, before writing the "verified" line in FEATURES — which is
now the rule: a function's FEATURES entry gets its "live" line only after a real call succeeds.

## 2026-09-13 — ingest 500: permission denied for table ingest_runs
**Symptom:** with auth fixed, the next call reached the handler and failed immediately —
`500 {"error": "ingest_runs insert: permission denied for table ingest_runs"}`. No run row, no
bars. Every one of the four tables was affected, not just this one.
**Root cause:** default privileges in Postgres are per **owner role**. Supabase's permissive
defaults ("new tables usable by anon / authenticated / service_role") hang off `supabase_admin`,
but a migration runs as `postgres`, whose defaults grant `service_role` only
`Dxtm` — TRUNCATE, REFERENCES, TRIGGER, MAINTAIN — and no DML at all. Live ACL read as
`service_role=Dxtm/postgres`. Not collateral damage from the foundation migration's revoke:
that named only `anon` and `authenticated`. These tables were never writable by the function.
**Fix:** `20260913003000_service_role_grants.sql` — `select, insert, update` on all four tables
to `service_role`, deliberately no `delete` (decision 0018).
**Earlier detection:** a smoke call immediately after the first deploy would have caught both
this and the auth bug in one go, roughly 40 minutes earlier. Two runtime bugs in a row from
"tests pass, therefore it works" — the FEATURES rule added yesterday (no "live" line until a
real call succeeds) now has teeth. A CI check is not possible: the grant only exists in the
deployed database, which CI cannot reach.

## 2026-09-13 — the daily backfill wrote monthly and quarterly bars into `daily_bars`
**Symptom:** the first successful ingest reported `ok: true`, 15,100 rows, no errors — and the
daily table was wrong. 1,164 rows across 4 index symbols, spaced 30.4 and 90.8 days apart, dated
the 1st of each month or quarter. Hourly in the same run was exactly right (3,484 bars each,
2024-09-12 → 2026-09-11), which is what made the daily numbers stand out.
**Root cause:** the full daily fetch used `range=max&interval=1d`. Yahoo chooses granularity
from the span and ignores `interval`, so a 40-year request comes back quarterly. Nothing in the
response says "this is not what you asked for": no error, plausible OHLC, a `timestamp` array of
the right shape. `CONSTRAINTS.md` had recorded "range=max (quarterly candles...)" back in August
and I paired it with `interval=1d` anyway, assuming the interval would win.
**Fix:** `chartUrl()` in `yahoo.ts` builds the full daily URL from `period1`/`period2` epochs and
is unit-tested to assert `range=` never appears in it. The 1,164 bad rows are deleted by hand —
they sit on non-trading dates, so a correct backfill would leave them in place rather than
overwrite them.
**Earlier detection:** a shape assertion, now the rule for every ingest: after a backfill, check
median spacing between bars and reject anything over ~5 days for a daily series. Row counts and
`ok: true` proved nothing here — the run was *successful*, it just fetched the wrong thing. A
fixture test cannot catch it either, since the fixture is whatever we believed the API returns.

## 2026-09-13 — Yahoo 429'd Supabase's IP and stayed angry
**Symptom:** three probe requests fired 3 minutes after the backfill returned plain-text
`429 Too Many Requests`; a single probe 6 minutes after still did. The backfill itself — ~90
requests in 6.9 seconds — had a 100% success rate, so nothing warned us on the way in.
**Root cause:** 4 concurrent requests with 250 ms pauses is roughly 13 requests/second. That is
inside whatever burst Yahoo tolerates but outside its sustained budget, and exceeding it buys a
penalty window measured in minutes, not seconds.
**Fix:** concurrency 4 → 2, pause 250 ms → 1000 ms (~2 req/s), and a 429 now raises
`RateLimitError`, which abandons the rest of the run instead of hammering. Abandoned symbols
land in `deferred` and the next run picks them up, because a symbol with no bars still qualifies
for the automatic full catch-up.
**Earlier detection:** none available — the limit is invisible until crossed, and Yahoo publishes
no number. What we can do is not discover it again: the cooldown length is still unmeasured, and
`detail->>'rate_limited'` now names this cause directly in `ingest_runs`.
