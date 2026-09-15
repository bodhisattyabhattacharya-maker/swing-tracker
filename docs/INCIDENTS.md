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
no number. What we can do is not discover it again: `detail->>'rate_limited'` names this cause
directly in `ingest_runs`, and pacing is now declared by each provider from its *published*
limit rather than guessed.
**Outcome (same day):** there was no cooldown. `429` persisted through 90 minutes of silence,
then through 4.5 hours, then on `query2.finance.yahoo.com` as well. The endpoint was abandoned
and the provider replaced — decision 0019. The lasting lesson is not about pacing: it is that
an unofficial endpoint can withdraw consent permanently and without recourse, so the thing to
avoid was depending on one, not merely hitting it too fast.

## 2026-09-13 — every equity rejected: Polygon returns volume as a float
**Symptom:** first run on the new provider returned `504` and was killed at exactly 150 seconds
with `finished_at` null, so no per-symbol errors were recorded at all — the only evidence was
the status code. FRED's three index series had written 8,049 rows correctly; Polygon had written
nothing. A single-symbol probe (`?scope=daily&symbols=MU&limit=1`) returned in seconds with the
real cause: `daily_bars upsert: invalid input syntax for type bigint: "25426639.075335"`.
**Root cause:** Polygon reports aggregate volume as a **float** — fractional share volume summed
up — and `daily_bars.volume` is `bigint`. PostgreSQL rejects the whole batch, so every equity
failed at the upsert rather than the fetch. Polygon itself was working perfectly the entire time.
**Fix:** `Math.round()` in `mapAggs`. Rounding rather than widening the column: volume is a share
count, the only parameter reading it is a ratio against a 50-bar average, and a fraction of a
share cannot move it. Two tests pin it — the exact failing value, and that a null volume stays
null rather than rounding to zero.
**Two other defects the same incident exposed**, both of which made diagnosis harder than the bug:
- **No per-request timeout.** An unanswered `fetch` hung until the 150 s wall clock killed the
  run. Now `AbortSignal.timeout(20_000)` on both providers, so a hang becomes a recorded error.
- **`fetched` was incremented twice** for a symbol that failed after its request — once before
  the upsert and again in the catch — silently halving each run's budget. Now counted once, at
  the moment the request is made.
- **No logging whatsoever.** A killed run left no breadcrumbs; I diagnosed a 504 by arithmetic.
  Each symbol now logs before its attempt and after its result.
**Earlier detection:** no fixture could have caught this — the fixture is whatever we believed
the API returns, and we believed volume was an integer because every other provider reports it
that way. What *would* have caught it: a one-symbol smoke call before a full run, which cost
seconds and gave the exact error. That is now the first step in the debug-ingest skill.
**Still unexplained, honestly:** the 150 s exhaustion. Three FRED series plus a handful of
failing equities should have completed in well under a minute. The timeout and the logging exist
precisely so that if it recurs it is diagnosable rather than inferred.

## 2026-09-13 — the backfill could not make progress, and would have looped forever
**Symptom:** run 1 of the backfill wrote seven equities. Run 2, identical command, wrote **one**
new symbol and left `deferred` at 28 — it had spent its whole eleven-symbol budget re-fetching
five weeks of data for the eight names that were already complete. A third run would have done
the same, and a fourth, indefinitely.
**Root cause:** the loop walked symbols alphabetically and decided each one's range as it went,
so "needs 494 bars" and "needs 24 bars" competed on equal footing for the same budget. The
alphabetically-first symbols were complete, so the budget was consumed before reaching anything
that actually needed work. A scheduled job would have looked healthy — `ok: true`, rows written —
while making no progress at all, which is the worst shape a bug can have.
**Fix:** plan the whole run before fetching anything, and sort symbols needing a full backfill
ahead of those needing a top-up. The log line now states the split ("N to backfill, M to top
up") so a stalled run is visible at a glance.
**A second defect found the same way:** `hasBars` was called OUTSIDE the per-symbol try, so a
single failing count aborted the entire run — twice, on SMCI and WMT, taking 15 symbols' work
with them. A third run died on `tickers read` before touching any symbol. All three were
PostgREST returning "Gateway Timeout" or an error with an **empty message**, on a project
reporting `ACTIVE_HEALTHY`. Reads now retry once after 400 ms, and a count failure costs one
symbol rather than the run. Writes are deliberately **not** retried.
**Earlier detection:** the pattern is now explicit enough to name, because it is the third time
tonight: **one symbol's problem must never cost another symbol's work.** The double-incremented
budget, the count that killed a run, and this ordering stall are all the same mistake wearing
different clothes. When reviewing this loop, ask of every failure "what else does this take
down?" — not merely "is it handled?".

## 2026-09-13 — a revoke that revoked nothing, and reported success
**Symptom:** migration `20260913061500` ran `revoke execute on function public.rls_auto_enable()
from anon, authenticated` and applied cleanly. Supabase's security advisor, re-run afterwards,
still reported the function as executable by `anon`. Nothing had changed.
**Root cause:** PostgreSQL grants `EXECUTE` to **PUBLIC** automatically when a function is
created, and `anon` / `authenticated` inherit from PUBLIC rather than holding grants of their
own. The ACL showed it plainly once read:

```
proacl = {=X/postgres, postgres=X/postgres}
```

The entry with an **empty grantee** — `=X/postgres` — is the grant to PUBLIC. Revoking from the
two named roles removed privileges they never had. The correct statement is
`revoke execute ... from public`.
**Fix:** `20260913062000`, revoking from PUBLIC. The failed migration is kept unedited —
migrations are forward-only (decision 0016) — and its mistake is documented in the new one's
header so the next reader sees both.
**Earlier detection:** the migration status was never the evidence. What caught it was reading
`pg_proc.proacl` and re-running the advisor after applying. Generalising: **a successful
migration is not a verified outcome.** This is the second time today the same shape has bitten —
Supabase's "Deploy to production" toggle also reported saved while changing nothing, and PR #1
merged without applying its migration. Verify the state, not the operation.
**Rule of thumb worth keeping:** when revoking on a function, check `proacl` for a leading `=`
before naming roles. A revoke listing roles individually is almost always the wrong shape for a
default grant.

## 2026-09-13 — A function merged, deployed clean, and did not exist
**Symptom:** `POST /functions/v1/digest?send=0` returned **404**. The PR had merged, the Supabase
integration had run, the migration in the same PR applied, and `ingest` redeployed to version 23.
Nothing anywhere reported a failure.
**Cause:** the Supabase GitHub integration deploys only functions declared in
`supabase/config.toml`. The file had a `[functions.ingest]` block and no `[functions.digest]` one.
A new directory under `supabase/functions/` with a valid `index.ts`, its own tests and a passing
`deno check` is **not** enough on its own.
**Why it took a 404 to notice:** every signal available said success. The merge was green, the
integration ran, a migration from the same commit landed in the database, and the one function
that was declared got a new version. The deploy did exactly what it was configured to do — the
configuration was just incomplete, and an incomplete configuration is indistinguishable from a
complete one unless you go looking for the thing that should have appeared.
**Fix:** a `[functions.digest]` block, plus a comment at the top of `config.toml` saying every
function needs one and naming this incident.
**The family it belongs to:** this is the fifth time on this project that a successful-looking
operation changed nothing — after the "Deploy to production" toggle that deployed nothing, the
merged PR that applied no migration, the `revoke` that revoked nothing, and the grid page
prerendered against a schema that did not exist yet. The lesson has not changed: **verify the thing
you wanted exists, not that the operation reported success.** `list_edge_functions` answered this
in one call; the deploy log never would have.

## 2026-09-14 — the first scheduled digest sent nothing, and cron called it a success

**What happened:** the first fully automatic weeknight ran. The ingest fetched Monday's bars and
succeeded (38 symbols, 35.9 s). The refresh rebuilt both matviews in 5.86 s. At 23:00 UTC the digest
fired, failed, and **no email was sent** — on a night with ten real crossings to report, including
META's daily RSI going above 70 and four names dropping below their "% off high" floor.

`public.ingest_runs` recorded it honestly: `ok = false`,
`{"digest": {"error": "digest_changes: JWT issued at future"}}`.

`cron.job_run_details` recorded **`status = succeeded`**.

**Cause: a single transient 401 from one PostgREST replica.** The digest issues three reads in
`Promise.all`. The edge log shows all three leaving in the same millisecond, carrying the same
service_role key:

```
23:00:01.002  GET /rest/v1/digest_changes    401
23:00:01.002  GET /rest/v1/grid_status       200
23:00:01.003  GET /rest/v1/digest_standing   200
```

Same key, same instant, two accepted and one rejected as future-dated. That is not a bad key and not
our auth code — it is one node in a load-balanced fleet whose clock had drifted behind the key's
`iat`. Across the seven hours around the run there were **144 PostgREST requests on that key and
exactly one 401**; a second later the same client POSTed to `ingest_runs` and got a 201. The ingest
half an hour earlier used the same env var for 78 calls without a single rejection.

**The real defect is ours, and it is not the 401.** Any read error throws, the catch writes
`ok = false`, and the function returns without sending. So a one-in-a-hundred-and-forty-four blip on
*one* of three reads discarded the two that had succeeded and produced **silence** — which is the
exact ambiguity the digest was built to remove. Decision 0027 says an email that simply stops
arriving is indistinguishable from a quiet market, and the function already honours that for stale
data by sending a short notice instead of nothing. It does not honour it for its own read failing.

**Fix:** task #49 — a bounded retry around the three reads (they are idempotent GETs and cost
nothing), and, if one still fails, send anyway with a "could not read X" line rather than sending
nothing. Plus a test for the read-failure path, which does not currently exist.

**What this cost:** Monday's ten crossings were never emailed. They are still in `digest_changes`,
so re-running the function would send that digest — but tonight's scheduled run compares Tuesday
against Monday, so without a deliberate re-send those ten crossings never reach the inbox at all.

**The family it belongs to — and a new member of it.** Five previous entries here are a successful
operation that changed nothing. This is the inverse and it is worse: **an operation that genuinely
failed, reported as a success by the signal most people would check.** `cron.job_run_details` said
`succeeded` because pg_net's `http_post` had queued the request, which is all that row has ever
meant. The authority order written into `20260913183000_cron_daily.sql` — `ingest_runs` first, the
freshness check second, `cron.job_run_details` last — was correct, and this is the night it paid for
itself. Anyone who had checked the cron log would have concluded the pipeline was healthy.

