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
  ('pct_off_52w_high', -25, null),
  -- The two weekly norms that config/norms.yml actually sets, so the weekly colouring path is
  -- exercised rather than merely present. close_vs_sma200w and close_vs_sma30w are deliberately
  -- absent here for the same reason they are absent there - see config/norms.yml.
  -- 40/70 since 2026-09-16 (decision 0038); at 45/65 it coloured 45.5% of judged cells.
  ('rsi_weekly', 40, 70),
  ('close_vs_ema21w', -5, 20),
  -- The RS norm, so rs_cells' verdict path is EXERCISED rather than merely present. Without this
  -- row every rs_cells verdict is null through the `no norm` arm and the parity check below it
  -- passes vacuously - which is exactly what it did on the first run of this file.
  ('rs_vs_spx_126b', 0, null),
  -- CI-ONLY, and deliberately NOT in config/norms.yml. rs_vs_spx_126b's real norm is one-sided at
  -- 0, and every fixture value is below it - so with that norm alone the verdict parity check
  -- exercised the `below` arm and the `no norm` arm and NOTHING ELSE. `normal` and `above` went
  -- untested, which is half a check. The fixture's rs_63b runs -7.59 .. -6.08, so this band puts
  -- values on both sides of it and inside it, and all three arms fire.
  ('rs_vs_spx_63b', -7, -6.5),
  -- CI-ONLY, and the bound is an EXACT fixture value rather than a round number. Until this row
  -- existed, NO cell in either view sat exactly on a norm boundary - measured, 0 of them - so `<`
  -- and `<=` produced identical output and the verdict checks could not tell them apart. Verified:
  -- changing rs_cells' `<` to `<=` passed every check before this line was added and fails after.
  -- If the fixture series is ever regenerated this number must be regenerated with it; the
  -- 'a value exactly on a norm bound is inside it' check fails loudly if it stops matching.
  ('rs_vs_spx_252b', -29.75206611570247, null),
  -- The two market norms config/norms.yml actually sets, so market_cells' verdict path is exercised
  -- rather than merely present. Without these, every market_cells verdict is null through the
  -- `no norm` arm and the parity check above passes vacuously - which is what it did on its first
  -- run. The fixture's VIX sweeps 9 .. 87 so all three arms fire, and its VIX3M dips below VIX on
  -- one date in seven, so term_structure is negative as well as positive.
  ('vix', 16, 30),
  ('term_structure', 0, null)
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
-- daily_signals reads daily_features, so it is refreshed AFTER it - unlike the two above, which
-- are siblings. Added 2026-09-17, and the gate went green with this matview entirely empty before
-- it was; the `no matview is empty` check below is the guard that stops the next one doing that.
refresh materialized view public.daily_signals;
-- market_history reads market_context, which reads daily_features. Same ordering argument, and the
-- same guard caught it: added 2026-09-18, and the gate failed with "0 empty | market_history" until
-- this line existed. Third time that generic check has found a matview nobody refreshed.
refresh materialized view public.market_history;
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
  psql -v ON_ERROR_STOP=1 --no-psqlrc -tAF'|' -f "$1" \
    | awk -F'|' -v p="$2" '$2 != "SUMMARY" && $4 ~ p {n++} END {print n+0}'
}

# A CHECK SCRIPT THAT DOES NOT RUN MUST NOT READ AS A PASS.
#
# This gate counted rows whose status was FAIL. A file with a syntax error emits NO rows, so it
# counted zero failures and reported "all green" - the gate itself doing the thing it exists to
# catch. Found 2026-09-15 when a doubled quote in a new market-context check made the whole of
# check_formulas.sql unparseable and the run still exited 0.
#
# Two guards, because either alone is escapable:
#   run_checks   runs the file with ON_ERROR_STOP and fails the build on a non-zero exit. The old
#                `2>/dev/null` in status_count actively hid the error message that would have
#                given it away.
#   expect_rows  insists the file produced at least N check rows. An empty result is now a failure
#                rather than a silence, which also catches a file that parses but selects nothing.
run_checks () {  # file, label, minimum rows
  if ! psql -v ON_ERROR_STOP=1 --no-psqlrc --quiet -P pager=off -f "$1"; then
    echo "    FAILED: $2 did not run to completion - see the error above"
    exit 1
  fi
  # awk rather than `grep -c`: grep exits 1 when it matches nothing, which under `set -o pipefail`
  # aborts this function before it can report anything, turning a clear "checked nothing" into a
  # bare non-zero exit. awk always exits 0 and the count is the whole point.
  local rows
  rows=$(psql -v ON_ERROR_STOP=1 --no-psqlrc -tAF'|' -f "$1" | awk 'NF {n++} END {print n+0}')
  if [ "$rows" -lt "$3" ]; then
    echo "    FAILED: $2 produced $rows rows, expected at least $3 - it ran but checked nothing"
    exit 1
  fi
}

echo "==> formula gate (independent reference implementation)"
# The row floors are deliberately blunt: they are not the real count, they are "far too few to be
# the real count". Tightening them to the exact number would make every added check a build break.
run_checks "$here/check_formulas.sql" "check_formulas.sql" 40
bad_formula=$(status_count "$here/check_formulas.sql" '^(FAIL|MISSING)$')

echo
echo "==> invariants and goldens (scripts/verify_parameters.sql)"
run_checks "$repo/scripts/verify_parameters.sql" "verify_parameters.sql" 30
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
