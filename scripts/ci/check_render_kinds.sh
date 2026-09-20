#!/usr/bin/env bash
#
# scripts/ci/check_render_kinds.sh — every way a value can be drawn must be drawn the same way in
# both places that draw it, and a kind nothing can reach must say so out loud.
#
# WHY THIS EXISTS
#
# `Render` has four members, and the fall-through in both renderers is the `number` case. Add a
# fifth member to the union, give it to a column, forget the branch, and that column renders as a
# number — silently, correctly typed, with a plausible-looking value in it. Nothing in the
# toolchain has an opinion about that.
#
# The second half is the one this project keeps learning. `sparkline` and `rank` are handled in
# both renderers and CANNOT BE REACHED TODAY: both renderers test `planned` before they test the
# render kind, and every column carrying either kind is planned until the financials ingest lands.
# That is fine and deliberate — but "fine and deliberate" is exactly what the last three
# unreachable things looked like too, so it is printed as a fact on every run rather than left in
# a comment for someone to find. When Stage F flips those columns to live, this check's output
# changes on its own.
#
# WHAT IT CHECKS
#   1. Every member of the `Render` union is used by at least one column. A kind in the type that
#      no column carries is dead vocabulary.
#   2. Every kind a column carries is handled by an EXPLICIT branch in BOTH renderers — the grid's
#      `Cell` and the strip's payload — except `number`, which is the documented fall-through and
#      must NOT have one. A kind handled in one and not the other is the 2026-09-18 defect in a
#      new room: the same column reading two different ways in two tabs.
#   3. Every `CellLike` field a kind's payload lives in is declared on `CellLike`.
#   4. Reachability, reported: which kinds can appear on screen today, given that both renderers
#      test `planned` first. Not a failure — a statement, printed every run.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
web="$repo/web"

for f in lib/columns.ts components/ParameterGrid.tsx components/StockStrip.tsx; do
  if [ ! -f "$web/$f" ]; then
    echo "FAILED: $web/$f not found - this check is looking in the wrong place"
    exit 1
  fi
done

node - "$web" <<'JS'
const fs = require("node:fs");
const path = require("node:path");
const web = process.argv[2];
const read = (p) => fs.readFileSync(path.join(web, p), "utf8");

const problems = [];
const bad = (m) => problems.push(m);
let checks = 0;

const columns = read("lib/columns.ts");

// --------------------------------------------------------------------------- the union
const union = columns.match(/export type Render\s*=\s*([^;]+);/);
if (!union) {
  console.log("FAILED: could not find the Render union in lib/columns.ts");
  process.exit(1);
}
const KINDS = [...union[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
if (KINDS.length === 0) {
  console.log("FAILED: the Render union parsed to zero members");
  process.exit(1);
}

// --------------------------------------------------------------------------- what columns carry
const catalogue = columns.match(/export const COLUMNS:\s*Column\[\]\s*=\s*\[([\s\S]*?)\n\];/);
if (!catalogue) {
  console.log("FAILED: could not find the COLUMNS array in lib/columns.ts");
  process.exit(1);
}
// One entry per `param:`; each entry runs to the next `param:` or the end.
const entries = catalogue[1].split(/(?=\{\s*param:)/).filter((e) => /param:\s*"/.test(e));
if (entries.length === 0) {
  console.log("FAILED: COLUMNS parsed to zero columns");
  process.exit(1);
}
const used = new Map();   // kind -> { total, live, sample }
for (const e of entries) {
  const kind = (e.match(/render:\s*"([a-z]+)"/) || [, "number"])[1];
  const live = /status:\s*"live"/.test(e);
  const param = (e.match(/param:\s*"([a-z0-9_]+)"/) || [, "?"])[1];
  if (!used.has(kind)) used.set(kind, { total: 0, live: 0, sample: param });
  const u = used.get(kind);
  u.total++;
  if (live) {
    u.live++;
    if (u.liveSample === undefined) u.liveSample = param;
  }
}
console.log(`  catalogue ${entries.length} columns, ${KINDS.length} render kinds declared`);

// 1. no dead vocabulary
for (const k of KINDS) {
  checks++;
  if (!used.has(k)) bad(`the Render union declares "${k}" but no column carries it`);
}
// and the reverse: a column carrying a kind the union does not declare would not typecheck, but
// the parse could still drift, so it is asserted rather than assumed.
for (const k of used.keys()) {
  checks++;
  if (!KINDS.includes(k)) bad(`a column carries render "${k}", which is not in the Render union`);
}

// --------------------------------------------------------------------------- 2. both renderers
const RENDERERS = [
  ["grid", "components/ParameterGrid.tsx"],
  ["strip", "components/StockStrip.tsx"],
];
const FALLTHROUGH = "number";
const handled = {};
for (const [name, file] of RENDERERS) {
  const src = read(file);
  handled[name] = new Set(
    [...src.matchAll(/col\.render\s*===\s*"([a-z]+)"/g)].map((m) => m[1]),
  );
  for (const k of KINDS) {
    checks++;
    const has = handled[name].has(k);
    if (k === FALLTHROUGH) {
      if (has) {
        bad(`the ${name} renderer branches on "${k}", which is the documented fall-through - two places now decide the same case`);
      }
      continue;
    }
    if (!has) {
      bad(`the ${name} renderer has no branch for render kind "${k}" (e.g. ${used.get(k)?.sample ?? "?"}) - it would fall through and draw as a plain number`);
    }
  }
}
// The two must agree, or one column reads two ways in two tabs.
checks++;
const onlyGrid = [...handled.grid].filter((k) => !handled.strip.has(k));
const onlyStrip = [...handled.strip].filter((k) => !handled.grid.has(k));
if (onlyGrid.length) bad(`handled in the grid but not the strip: ${onlyGrid.join(", ")}`);
if (onlyStrip.length) bad(`handled in the strip but not the grid: ${onlyStrip.join(", ")}`);

// --------------------------------------------------------------------------- 3. payload fields
// Where each kind's value lives on CellLike. A kind reading a field that is not declared there
// would be `undefined` at runtime and render as empty.
const PAYLOAD = { number: ["value"], chip: ["label", "tone"], sparkline: ["series"], rank: ["value", "peers"] };
const cellLike = columns.match(/export interface CellLike\s*\{([\s\S]*?)\n\}/);
if (!cellLike) bad("could not find the CellLike interface in lib/columns.ts");
else {
  const fields = new Set([...cellLike[1].matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]));
  for (const k of KINDS) {
    const want = PAYLOAD[k];
    checks++;
    if (!want) {
      bad(`render kind "${k}" has no payload recorded in this check - add it to PAYLOAD so the field it reads is verified`);
      continue;
    }
    for (const f of want) {
      checks++;
      if (!fields.has(f)) bad(`render kind "${k}" reads CellLike.${f}, which is not declared on CellLike`);
    }
  }
}

// --------------------------------------------------------------------------- 4. reachability
// Both renderers test `planned` before the render kind, so a kind is reachable only when some
// column carrying it is live. Reported, never failed - see the header.
console.log("  reachability (both renderers test planned before the render kind):");
for (const k of KINDS) {
  const u = used.get(k);
  if (!u) continue;
  if (u.live > 0) {
    console.log(`    reachable    ${k.padEnd(10)} ${u.live} of ${u.total} columns live, e.g. ${u.liveSample}`);
  } else {
    console.log(`    UNREACHABLE  ${k.padEnd(10)} all ${u.total} columns planned (${u.sample}) - draws the planned dash until those go live`);
  }
}

// --------------------------------------------------------------------------- result
console.log(`  ${checks} assertions`);
if (problems.length > 0) {
  console.log();
  for (const p of problems) console.log("  FAILED    " + p);
  console.log(`\n  FAILED (${problems.length})`);
  process.exit(1);
}
console.log("  PASS      every render kind is used, handled in both renderers, and reads a declared field");
JS
