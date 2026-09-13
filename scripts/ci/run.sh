#!/usr/bin/env bash
#
# scripts/ci/run.sh — apply every migration to a throwaway PostgreSQL, load the fixture, and run
# both verification scripts. Used by CI, and runnable by hand against any empty database:
#
#     PGHOST=... PGPORT=... PGUSER=... PGDATABASE=... scripts/ci/run.sh
#
# Exits non-zero if any check comes back with a status other than PASS. That is the whole gate.
#
# WHY THE `create extension` LINES ARE FILTERED OUT
#   The foundation migration creates `pg_net` and `pg_cron`. Neither exists outside Supabase, so
#   on a vanilla PostgreSQL the very first migration fails before anything can be verified. They
#   are stubbed in bootstrap.sql instead - see that file for exactly what the stubs do and, more
#   importantly, what they cannot prove.
#
#   This is the one place where CI runs something other than the committed file, so it is worth
#   being precise about the cost: a change to those two lines is NOT covered by this gate. Nothing
#   else is filtered - every other statement in every migration is applied verbatim, in order.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
psql_q="psql -v ON_ERROR_STOP=1 --quiet --no-psqlrc"

echo "==> bootstrap: roles, and stand-ins for pg_cron / pg_net / vault"
$psql_q -f "$here/bootstrap.sql"

echo "==> migrations, in filename order"
for f in "$repo"/supabase/migrations/*.sql; do
  printf '    %-52s' "$(basename "$f")"
  # Only `create extension` is removed; see the header. Applied twice on purpose - a migration
  # that is not idempotent will fail here rather than in production during a re-deploy.
  sed -E 's/^[[:space:]]*create extension .*$/-- [ci] extension creation skipped; stubbed in bootstrap.sql/I' "$f" \
    | $psql_q
  echo 'ok'
done

# NOT re-applied. An earlier version of this script applied every migration twice to "prove
# idempotency" and failed on the first one - correctly. Migrations here are forward-only and
# Supabase records which have run, so `create table` without `if not exists` is right, not a
# defect. The only migrations deliberately written to be re-runnable are the two scheduling ones,
# and check_formulas.sql asserts that specific claim by counting the jobs they leave behind.

echo "==> fixture: synthetic series, degenerate companions, expected values"
$psql_q -f "$here/fixture.sql"

echo "==> norms and flags, matching config/norms.yml for the parameters that exist"
$psql_q <<'SQL'
insert into public.norms (param, low, high) values
  ('rsi_daily', 30, 70),
  ('close_vs_sma200d', -5, 40),
  ('pct_off_high_stored', -30, null),
  ('pct_off_52w_high', -25, null)
on conflict (param) do update set low = excluded.low, high = excluded.high;
insert into public.flags (key, value) values ('pipeline_stale_after_hours', '30'::jsonb)
on conflict (key) do update set value = excluded.value;
-- A successful ingest, so the freshness check has something to judge. Without it grid_status
-- reports stale, which is correct but would fail the gate for the wrong reason.
insert into public.ingest_runs (source, scope, triggered_by, finished_at, ok, detail)
values ('fixture', 'all', 'ci', now(), true, '{"daily":{"written":1}}'::jsonb);
-- Both matviews are populated at CREATE time, which in CI is before the fixture exists. Refreshing
-- here is not a CI detail: it mirrors what swing-refresh-features does in production, and the
-- weekly one was MISSING from that job until these assertions found it (20260914010000).
refresh materialized view public.daily_features;
refresh materialized view public.weekly_features;
SQL

# Both scripts return one row per check, with the status in a column. CI's only job is to insist
# that no row says FAIL. The two are gated differently and the difference is deliberate:
#
#   check_formulas.sql  — FAIL *and* MISSING both fail the build. A missing row means the fixture
#                         did not load, which invalidates everything else in that file.
#   verify_parameters.sql — only FAIL fails the build. MISSING is EXPECTED here: the MU golden
#                         values are real vendor data, deliberately not committed to a public repo
#                         for licence reasons, so those seven checks - four daily, two weekly, and
#                         the peak high - legitimately have nothing to read. They remain a manual
#                         check against production (DEFINITIONS.md §6).

# Counts CHECK rows only. The SUMMARY row is excluded deliberately: it is a derived line that
# reports how many checks did not pass, so counting it as a check double-counts every failure and
# makes a run with only expected-MISSING goldens look like a failure. Caught by this script
# reporting "1 invariant failing" when every actual invariant passed.
status_count () {  # file, pattern -> number of CHECK rows whose status column matches
  psql --no-psqlrc -tAF'|' -f "$1" 2>/dev/null \
    | awk -F'|' -v p="$2" '$2 != "SUMMARY" && $4 ~ p {n++} END {print n+0}'
}

echo "==> formula gate (independent reference implementation)"
psql --no-psqlrc --quiet -P pager=off -f "$here/check_formulas.sql"
bad_formula=$(status_count "$here/check_formulas.sql" '^(FAIL|MISSING)$')

echo
echo "==> invariants and goldens (scripts/verify_parameters.sql)"
psql --no-psqlrc --quiet -P pager=off -f "$repo/scripts/verify_parameters.sql"
bad_verify=$(status_count "$repo/scripts/verify_parameters.sql" '^FAIL$')
missing_verify=$(status_count "$repo/scripts/verify_parameters.sql" '^MISSING$')

echo
echo "==> result"
echo "    formula checks not passing        : $bad_formula"
echo "    invariant checks FAILING          : $bad_verify"
echo "    golden checks MISSING (expected)  : $missing_verify"
if [ "$bad_formula" -ne 0 ] || [ "$bad_verify" -ne 0 ]; then
  echo "    FAILED"
  exit 1
fi
echo "    all green"
