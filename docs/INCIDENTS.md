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
