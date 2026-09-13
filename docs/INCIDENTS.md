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
