#!/usr/bin/env bash
#
# scripts/ci/check_cell_states.sh — every cell state the grid declares must be reachable.
#
# WHY THIS EXISTS.
#
# `web/lib/columns.ts` declares eight `CellState` values. Each one has a colour, a legend entry and
# its own CSS in `app/layout.tsx`. On 2026-09-17, one of them - `na`, "the question does not apply
# to this security" - could not appear on screen at all: `cellState` tested `status === "planned"`
# before `applies`, and all 28 columns carrying an `applies` predicate were also `planned`, so the
# `na` branch was dead for every column against every security. The page documented and styled a
# state it could never render, and nothing caught it, because the code compiled and the branch was
# syntactically live.
#
# That is the shape of bug this project keeps meeting: something that LOOKS present and is not
# (a matview never refreshed, a verdict check with no matching norm, a bars-since assertion whose
# guard excluded the bar it existed to test). The answer has each time been a GENERIC check rather
# than one more specific assertion, so this one enumerates the states rather than naming any.
#
# WHAT IT PROVES, AND WHAT IT DOES NOT.
#
# It proves each declared state is produced by at least one (column, security, cell) triple drawn
# from a deliberately exhaustive matrix. It does NOT prove the state is reachable from PRODUCTION
# data - a state could be reachable in principle and never occur - and it says nothing about
# whether the state is the RIGHT one. Those are different questions and this is not the check for
# them.
#
# Run from the repo root or anywhere; it locates the repo itself.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
web="$repo/web"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

fail=0
note () { printf '  %s\n' "$1"; }

if [ ! -f "$web/lib/columns.ts" ]; then
  echo "FAILED: web/lib/columns.ts not found - this check is looking in the wrong place"
  exit 1
fi

# Emit to plain CommonJS so node can require it without a bundler. `--skipLibCheck` because we are
# type-checking this file's OWN shape, not the ambient DOM/Next types - `npm run build` is the real
# type gate and runs separately.
if ! (cd "$web" && npx --no-install tsc lib/columns.ts \
        --outDir "$out" --module commonjs --target es2020 --skipLibCheck >"$out/tsc.log" 2>&1); then
  echo "FAILED: could not compile web/lib/columns.ts"
  cat "$out/tsc.log"
  exit 1
fi

node - "$out" "$web/lib/columns.ts" <<'JS'
const path = require("path");
const out = process.argv[2];
const columnsTs = process.argv[3];
const mod = require(path.join(out, "columns.js"));
const { COLUMNS, cellState } = mod;

if (!Array.isArray(COLUMNS) || COLUMNS.length === 0) {
  console.log("FAILED: COLUMNS is empty - this check would pass vacuously");
  process.exit(1);
}

// The declared states, read from the source rather than retyped here. A state added to the union
// without a way to reach it is exactly what this check is for, so the list must not be a copy.
const src = require("fs").readFileSync(columnsTs, "utf8");
const m = src.match(/export type CellState =([\s\S]*?);/);
if (!m) {
  console.log("FAILED: could not find the CellState union in web/lib/columns.ts");
  process.exit(1);
}
const declared = [...m[1].matchAll(/"([a-z-]+)"/g)].map((x) => x[1]);
if (declared.length < 2) {
  console.log(`FAILED: parsed only ${declared.length} states from the CellState union`);
  process.exit(1);
}

// Every shape a security can have, and every shape a cell can arrive in - including absent, which
// is not the same as a cell whose value is null.
const securities = [
  { symbol: "NVDA", is_fund: false, rankable: true },
  { symbol: "ARM",  is_fund: false, rankable: false },
  { symbol: "SPY",  is_fund: true,  rankable: false },
];
const cells = [
  undefined,
  {},
  { value: null },
  { value: 1, has_norm: false },
  { value: 1, has_norm: true, verdict: "below" },
  { value: 1, has_norm: true, verdict: "above" },
  { value: 1, has_norm: true, verdict: "normal" },
  { value: 1, has_norm: true, verdict: null },
  { value: 1, has_norm: true, verdict: "normal", suppressed_warmup: true },
  { label: null },
  { label: "Golden", value: 12, tone: "bull" },
  { label: "Bear",   value: 3,  tone: "bear" },
  { label: "Mixed",  value: null, tone: "neutral" },
  { label: "Golden", tone: "bull", suppressed_warmup: true },
];

const witness = new Map();
for (const col of COLUMNS) {
  for (const sec of securities) {
    for (const cell of cells) {
      const st = cellState(col, sec, cell);
      if (!witness.has(st)) witness.set(st, `${col.param} / ${sec.symbol}`);
    }
  }
}

const unreachable = declared.filter((s) => !witness.has(s));
const undeclared = [...witness.keys()].filter((s) => !declared.includes(s));

for (const s of declared) {
  if (witness.has(s)) console.log(`  ok        ${s.padEnd(9)} e.g. ${witness.get(s)}`);
}
let bad = 0;
for (const s of unreachable) {
  console.log(`  FAILED    ${s.padEnd(9)} declared in CellState but no column, security or cell shape produces it`);
  bad++;
}
for (const s of undeclared) {
  console.log(`  FAILED    ${s.padEnd(9)} produced by cellState but absent from the CellState union`);
  bad++;
}

// -------------------------------------------------------------------------
// A state can be reachable in code and still have no way to be SEEN.
//
// THE FIRST VERSION OF THIS SECTION WAS VACUOUS and its own negative test proved it: it asked
// `grep -q "st-above"`, which a single mention anywhere in the file satisfies - including the
// comment explaining the rule. Renaming the actual selector left the comment behind and the check
// passed. So the test is now specific: the state must appear AS A CLASS IN A SELECTOR, in a rule
// that opens a block, with CSS comments stripped first so prose cannot vouch for a rule.
// -------------------------------------------------------------------------
const layoutPath = path.join(path.dirname(path.dirname(columnsTs)), "app", "layout.tsx");
let css = require("fs").readFileSync(layoutPath, "utf8");
css = css.replace(/\/\*[\s\S]*?\*\//g, " ");   // CSS comments
css = css.replace(/^\s*\/\/.*$/gm, " ");       // line comments in the surrounding TSX

for (const s of declared) {
  // `.st-<state>` inside a selector: from the class token to the `{` that opens its block, with
  // nothing in between that would mean we had left the selector.
  const re = new RegExp(`\\.st-${s}(?![a-z0-9-])[^{};]*\\{`);
  if (!re.test(css)) {
    console.log(`  FAILED    ${s.padEnd(9)} reachable, but app/layout.tsx has no rule whose selector carries .st-${s}`);
    bad++;
  }
}
process.exit(bad === 0 ? 0 : 1);
JS
rc=$?
[ "$rc" -ne 0 ] && fail=1

if [ "$fail" -ne 0 ]; then
  echo "FAILED: see above"
  exit 1
fi
echo "  all cell states reachable and styled"
