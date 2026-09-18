#!/usr/bin/env bash
#
# scripts/ci/check_web_boundary.sh — the one rule that cannot be left to a comment.
#
# `web/lib/grid.ts` reads the database with the SERVICE_ROLE key. `web/components/*` runs in the
# browser. If a client component ever imports the data layer, Next bundles that module — and its
# env access — into JavaScript served to every visitor.
#
# The repo is PUBLIC. A service_role key that reaches the bundle is not a bug you fix; it is a
# credential you rotate, in a file anyone already cloned. So this is a build failure, not a review
# note, and it runs before anything else in CI.
#
# WHAT IT CHECKS, precisely:
#   1. No file containing "use client" imports from lib/grid.
#   2. lib/columns.ts and lib/market.ts - the modules client components ARE allowed - never read
#      process.env. They are pure configuration and must stay that way, or rule 1 becomes theatre.
#   3. No NEXT_PUBLIC_ variable name contains SERVICE or ROLE. Next inlines every NEXT_PUBLIC_*
#      into the client bundle at build time; that prefix is the entire hazard.
#   4. No backtick inside the CSS template literal in app/layout.tsx. Not a security rule - it is
#      here because it is the same shape of problem and the same file. A backtick anywhere in that
#      string ENDS the string, and the error Next reports is "Expected a semicolon" pointing at a
#      line of English prose, which reads as a mystery rather than a typo. It has now cost this
#      project three builds (2026-09-16 twice, 2026-09-17 once), each time in a comment explaining
#      a CSS class in `backticks`. A guard comment above the literal did not stop the third.
#
# Deliberately a grep and not a lint plugin: this needs to be readable by someone who has never
# seen the project, and to keep working when the toolchain changes.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
web="$(cd "$here/../../web" && pwd)"
fail=0

echo "==> web boundary: no client component may import the data layer"

# 1. Client components must not reach lib/grid.
# The DIRECTIVE, not the string. "use client" only has meaning as the first statement in a file;
# matching it anywhere also matched this rule being DESCRIBED in a comment, which listed lib/grid.ts
# itself as a client component. A detector that flags the thing it is documenting is noise, and
# noise in a security check is how the real hit gets scrolled past.
#
# `[[:space:]]` and not `\s`: POSIX ERE has no `\s`, so the first version of this line matched
# nothing at all and the check reported a clean boundary over an empty list. A security check that
# passes because it examined nothing is worse than no check.
client_files=""
while IFS= read -r f; do
  if head -1 "$f" | grep -qE '^[[:space:]]*"use client"[[:space:]]*;?[[:space:]]*$'; then
    client_files="$client_files $f"
  fi
done < <(find "$web" -path '*/node_modules' -prune -o \( -name '*.tsx' -o -name '*.ts' \) -print)

if [ -z "$client_files" ]; then
  echo "    no client components found"
else
  for f in $client_files; do
    if grep -qE 'from "[^"]*lib/grid"' "$f"; then
      echo "    FAILED: ${f#"$web"/} is a client component and imports lib/grid."
      echo "            lib/grid.ts holds SUPABASE_SERVICE_ROLE_KEY. Importing it here puts that"
      echo "            module in the browser bundle. Pass data as props instead; import"
      echo "            lib/columns.ts for anything the component needs to know about columns."
      fail=1
    else
      echo "    ok: ${f#"$web"/}"
    fi
  done
fi

# 2. The modules client components may import must stay pure.
for pure in "$web/lib/columns.ts" "$web/lib/market.ts"; do
  [ -f "$pure" ] || continue
  if grep -qE 'process\.env|Deno\.env' "$pure"; then
    echo "    FAILED: ${pure#"$web"/} reads the environment."
    echo "            It is imported by client components precisely because it cannot. Move"
    echo "            anything that needs a secret into lib/grid.ts."
    fail=1
  else
    echo "    ok: ${pure#"$web"/} is pure"
  fi
done

# 3. Nothing secret may wear the NEXT_PUBLIC_ prefix.
if grep -rqE 'NEXT_PUBLIC_[A-Z_]*(SERVICE|ROLE)' "$web" 2>/dev/null; then
  echo "    FAILED: a NEXT_PUBLIC_ variable name mentions SERVICE or ROLE."
  echo "            Next inlines every NEXT_PUBLIC_* into the client bundle at build time."
  fail=1
else
  echo "    ok: no NEXT_PUBLIC_ name mentions SERVICE or ROLE"
fi

# 4. No backtick inside the CSS template literal. See the header for why this is worth a CI rule.
layout="$web/app/layout.tsx"
if [ -f "$layout" ]; then
  # From the line that opens the literal to the line that closes it, exclusive of both. The opener
  # and closer are themselves matched on their own distinctive text so a backtick on either is not
  # mistaken for one inside.
  stray=$(awk '
    /^const CSS = `$/        { inside = 1; next }
    inside && /^`;$/         { inside = 0; next }
    inside && /`/            { printf "      line %d: %s\n", NR, $0 }
  ' "$layout")
  if [ -n "$stray" ]; then
    echo "    FAILED: app/layout.tsx has a backtick inside the CSS template literal."
    echo "            It ends the string. Next reports \"Expected a semicolon\" at whatever prose"
    echo "            follows, which is not a hint. Use .st-below or \"quotes\" in that comment."
    printf '%s\n' "$stray"
    fail=1
  else
    echo "    ok: no backtick inside the CSS template literal"
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo "    FAILED: the web boundary is broken. This repo is public; a leaked key cannot be un-leaked."
  exit 1
fi
echo "    boundary intact"
