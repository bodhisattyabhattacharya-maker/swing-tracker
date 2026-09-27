#!/usr/bin/env bash
#
# scripts/ci/check_stat_tracks.sh — a reading past the end of its own rule must be visible, and a
# stat with no track must have had that decided rather than forgotten.
#
# WHAT THIS CANNOT DO, said first so the rest is not read as more than it is: it runs without a
# database, so it CANNOT check that the spans still fit the live watchlist. Only production data
# can answer that. What it can do is guarantee that a misfit SHOWS - clamped, flagged, and styled
# as pinned - instead of being drawn as an ordinary marker sitting at an end.
#
# WHY THIS EXISTS
#
# The spans in `lib/statplot.ts` were measured against the live watchlist on one day. That is the
# right way to choose them and the wrong thing to leave unguarded: the watchlist changes, a name
# has a bad quarter, and a reading lands past the end of a rule that was drawn to fit last
# month's data. The failure is quiet — a marker pinned to an edge looks like a marker, so a stat
# stuck at 100% reads as "the highest this ever gets" rather than "off the scale".
#
# So the check asserts the two things that make a track honest:
#   1. **A value outside the span is CLAMPED AND FLAGGED**, never drawn past the end of its own
#      rule. This is the property the component's `pinned` styling depends on, and it is the whole
#      reason an out-of-date span degrades loudly rather than quietly: if `clamped` stopped being
#      set, the marker would still be placed at the edge and nothing would say so.
#   2. **Every param a track is withheld from says why.** `pct_above_low_stored` has no track
#      because it spans 120% to 5,350% and no linear scale shows both ends — that is a decision,
#      and a decision with a recorded reason is different from an omission. A future param that
#      quietly has neither a track nor an entry in UNTRACKED fails here.
#
# It also checks the arithmetic itself against hand-computed positions, because "the marker is
# halfway" is the entire claim a track makes and an off-by-a-factor would still look plausible.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
web="$repo/web"

if [ ! -f "$web/lib/statplot.ts" ]; then
  echo "FAILED: $web/lib/statplot.ts not found - this check is looking in the wrong place"
  exit 1
fi

node --experimental-strip-types - "$web" <<'JS' 2>&1 | grep -v "ExperimentalWarning\|--trace-warnings\|MODULE_TYPELESS\|Reparsing\|performance overhead\|add \"type\""
import fs from "node:fs";
import path from "node:path";
const web = process.argv[2];

const problems = [];
const bad = (m) => problems.push(m);
let checks = 0;
const near = (name, got, want, tol = 1e-9) => {
  checks++;
  if (got === null || Math.abs(got - want) > tol) bad(`${name}: got ${got}, expected ${want}`);
};

const m = await import(path.join(web, "lib/statplot.ts"));
const { TRACKS, UNTRACKED, track, trackLabel } = m;

// --------------------------------------------------------------------------- the spans are sane
for (const t of TRACKS) {
  checks++;
  if (!(t.hi > t.lo)) bad(`${t.param}: span ${t.lo}..${t.hi} is not increasing`);
  checks++;
  if (t.definitionAt !== undefined && !(t.definitionAt >= t.lo && t.definitionAt <= t.hi)) {
    bad(`${t.param}: its by-construction reference ${t.definitionAt} is outside its own span ${t.lo}..${t.hi}`);
  }
}
checks++;
if (new Set(TRACKS.map((t) => t.param)).size !== TRACKS.length) {
  bad("two tracks claim the same param - which one applies would depend on list order");
}

// --------------------------------------------------------------------------- the arithmetic
// Hand-computed. A track's whole claim is WHERE the marker is, so an error of a factor would
// still render a perfectly plausible picture.
near("off-52w-high at its span midpoint", track("pct_off_52w_high", -25)?.at, 0.5);
near("off-52w-high at the top of its span", track("pct_off_52w_high", 0)?.at, 1);
near("off-52w-high at the bottom", track("pct_off_52w_high", -50)?.at, 0);
near("off-5y-high at -30 on a -80..0 span", track("pct_off_high_stored", -30)?.at, 0.625);
near("realised vol at 25 on 0..100", track("realized_vol_20", 25)?.at, 0.25);
near("volume ratio at 1.5 on 0..3", track("volume_ratio", 1.5)?.at, 0.5);
// The norm bound lands where it should, and only when it is inside the span.
near("the -25 norm notch on a -50..0 span",
     track("pct_off_52w_high", -10, { low: -25, high: null })?.normAt, 0.5);
checks++;
if (track("realized_vol_20", 25, { low: -999, high: null })?.normAt !== null) {
  bad("a norm bound outside the span was drawn on the rule anyway");
}
near("1.0 is a third of the way along a 0..3 volume span",
     track("volume_ratio", 1.5)?.defAt, 1 / 3);

// --------------------------------------------------------------------------- clamped AND flagged
for (const [param, value] of [
  ["pct_off_52w_high", -72], ["pct_off_52w_high", 12],
  ["pct_off_high_stored", -95], ["realized_vol_20", 140], ["volume_ratio", 9],
]) {
  const t = track(param, value);
  checks++;
  if (!t) { bad(`${param} at ${value}: no track at all`); continue; }
  checks++;
  if (t.at < 0 || t.at > 1) bad(`${param} at ${value}: marker at ${t.at}, outside its own rule`);
  checks++;
  if (!t.clamped) {
    bad(`${param} at ${value} is past its span but clamped is false - the marker sits on the edge and nothing says so`);
  }
  checks++;
  if (!/pinned/.test(trackLabel(t))) bad(`${param} at ${value}: the label does not say it is pinned`);
}
// And the other half: an in-range value must NOT claim to be pinned, or the styling means nothing.
for (const [param, value] of [["pct_off_52w_high", -25], ["realized_vol_20", 50], ["volume_ratio", 1]]) {
  checks++;
  if (track(param, value)?.clamped) bad(`${param} at ${value} is inside its span but reports clamped`);
}

// --------------------------------------------------------------------------- refuses non-values
for (const v of [null, undefined, NaN, Infinity, -Infinity]) {
  checks++;
  if (track("realized_vol_20", v) !== null) {
    bad(`track() returned a position for ${String(v)} - a non-value would be drawn as a marker somewhere`);
  }
}

// --------------------------------------------------------------------------- every stat accounted for
// The five params in the Price statistics section. Each must either have a track or a recorded
// reason for not having one; neither-nor is the case this check exists to catch.
const STATS = [
  "pct_off_52w_high", "pct_off_high_stored", "pct_above_low_stored",
  "realized_vol_20", "volume_ratio",
];
// Read from the section catalogue rather than trusted from this list, so adding a stat to the
// section and forgetting the track fails here rather than rendering a bare row.
const dd = fs.readFileSync(path.join(web, "lib/deep-dive.ts"), "utf8");
const statsBlock = dd.match(/key: "stats",[\s\S]*?params: \[([\s\S]*?)\]/);
checks++;
if (!statsBlock) {
  bad("could not find the stats section's params in lib/deep-dive.ts");
} else {
  const actual = [...statsBlock[1].matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1]);
  checks++;
  if (JSON.stringify(actual) !== JSON.stringify(STATS)) {
    bad(`the stats section now holds ${actual.join(", ")} - this check still assumes ${STATS.join(", ")}`);
  }
  for (const p of actual) {
    checks++;
    const tracked = TRACKS.some((t) => t.param === p);
    const excused = UNTRACKED.has(p);
    if (!tracked && !excused) {
      bad(`"${p}" is in the Price statistics section with no track and no entry in UNTRACKED - decide and record which`);
    }
    checks++;
    if (tracked && excused) bad(`"${p}" is both tracked and listed as untracked`);
  }
}
checks++;
if (![...UNTRACKED.values()].every((why) => typeof why === "string" && why.length > 20)) {
  bad("an UNTRACKED entry has no real reason recorded - the point of the map is the reason");
}
checks++;
if (track("pct_above_low_stored", 500) !== null) {
  bad("pct_above_low_stored got a track - it spans 120% to 5,350% and no linear scale shows both ends");
}

console.log(`  tracks    ${TRACKS.length} tracked, ${UNTRACKED.size} deliberately untracked`);
for (const t of TRACKS) {
  console.log(`    ${t.param.padEnd(22)} ${String(t.lo).padStart(5)} .. ${String(t.hi).padEnd(5)}${t.definitionAt !== undefined ? `  reference at ${t.definitionAt}` : ""}`);
}
for (const [p, why] of UNTRACKED) console.log(`    ${p.padEnd(22)} none - ${why.slice(0, 60)}...`);
console.log(`  ${checks} assertions`);
if (problems.length > 0) {
  console.log();
  for (const p of problems) console.log("  FAILED    " + p);
  console.log(`\n  FAILED (${problems.length})`);
  process.exit(1);
}
console.log("  PASS      every stat has a track or a recorded reason, and nothing is drawn past its own rule");
JS
