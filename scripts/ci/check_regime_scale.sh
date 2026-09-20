#!/usr/bin/env bash
#
# scripts/ci/check_regime_scale.sh — the VIX regime scale must tile the number line, and every
# band it can produce must have somewhere to be drawn.
#
# WHY THIS EXISTS
#
# The scale has two kinds of edge and only one of them is pinned. 16 and 30 come from
# `config/norms.yml` and `supabase/functions/ingest/ingest_test.ts` already fails the build if
# `VIX_BAND` drifts from them. 50 and 80 are display-only constants that nothing else guards.
#
# Retuning the norm is a normal thing to do — it is why norms live in a config file — and nothing
# about editing `config/norms.yml` suggests you have just changed a chart. Set the VIX band to
# 40/60 after a bad year and the `high` band runs from 60 down to 50: negative width, silently
# swallowing every session between 50 and 60, on the one chart anybody would be reading during the
# event that prompted the retune. `market-history.ts` throws on that at module load; this check
# turns the throw into a build failure with a sentence rather than a stack trace at first render.
#
# It also closes the gap the ten-band work closed for columns: a band that classifies sessions but
# has no colour token, or no CSS class, or no entry in the component's colour map, is a session
# painted transparent — indistinguishable from a session with no VIX publication, which is a
# completely different fact.
#
# WHAT IT CHECKS
#   1. The bands tile: first opens downward, last opens upward, each band's top edge IS the next
#      band's bottom edge. No gap, no overlap, no session that belongs to two bands or none.
#   2. Edges strictly increase, and the display cuts sit above the norm rather than inside it.
#   3. `regimeOf` agrees with the table at every edge and on both sides of it — including that the
#      norm's own edges are INCLUSIVE, which is what the VIX tile does and what the strip must
#      therefore also do.
#   4. Every band key has a `--reg-<key>` token in all three theme blocks, a `.r-<key>` class, and
#      an entry in the component's colour map.
#   5. The unknown case survives: a row with no VIX is its own thing, never folded into a band.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
web="$repo/web"

for f in lib/market-history.ts app/layout.tsx components/MarketHistory.tsx; do
  if [ ! -f "$web/$f" ]; then
    echo "FAILED: $web/$f not found - this check is looking in the wrong place"
    exit 1
  fi
done

node --experimental-strip-types - "$web" <<'JS' 2>&1 | grep -v "ExperimentalWarning\|--trace-warnings\|MODULE_TYPELESS\|Reparsing\|performance overhead\|add \"type\""
import fs from "node:fs";
import path from "node:path";
const web = process.argv[2];
const read = (p) => fs.readFileSync(path.join(web, p), "utf8");

const problems = [];
const bad = (m) => problems.push(m);
let checks = 0;

// The module asserts its own scale at load. Catching that here is the difference between a build
// failure that says what is wrong and a stack trace at the top of the CI log - which is what this
// check's header promises, so it has to actually do it.
let m;
try {
  m = await import(path.join(web, "lib/market-history.ts"));
} catch (e) {
  console.log("  FAILED    lib/market-history.ts refused to load, which its own scale assertion does");
  console.log("            deliberately when the bands stop making sense:");
  console.log("            " + (e && e.message ? e.message : String(e)));
  console.log("\n  FAILED (1)");
  process.exit(1);
}
const { REGIME_BANDS, REGIME_CUTS, VIX_BAND, regimeOf, regimeCounts, bandRects, inBand } = m;

console.log(`  scale     ${REGIME_BANDS.length} bands, norm ${VIX_BAND.low}/${VIX_BAND.high}, display cuts ${REGIME_CUTS.high}/${REGIME_CUTS.stress}`);

// --------------------------------------------------------------------------- 1. it tiles
checks++;
if (REGIME_BANDS[0].lo !== null) bad(`the lowest band (${REGIME_BANDS[0].key}) has a floor - a VIX of 1 would belong to no band`);
checks++;
const last = REGIME_BANDS[REGIME_BANDS.length - 1];
if (last.hi !== null) bad(`the highest band (${last.key}) has a ceiling - a VIX above it would belong to no band`);
for (let i = 1; i < REGIME_BANDS.length; i++) {
  checks++;
  const below = REGIME_BANDS[i - 1], above = REGIME_BANDS[i];
  if (below.hi !== above.lo) {
    bad(`${below.key} ends at ${below.hi} but ${above.key} starts at ${above.lo} - that is a ${
      above.lo > below.hi ? "gap" : "overlap"} in the scale`);
  }
}

// --------------------------------------------------------------------------- 2. edges increase
const edges = REGIME_BANDS.map((b) => b.hi).filter((h) => h !== null);
for (let i = 1; i < edges.length; i++) {
  checks++;
  if (!(edges[i] > edges[i - 1])) bad(`the edges are not increasing: ${edges[i - 1]} then ${edges[i]}`);
}
checks++;
if (!(REGIME_CUTS.high > VIX_BAND.high)) {
  bad(`the first display cut (${REGIME_CUTS.high}) is not above the norm's top (${VIX_BAND.high}) - the display scale has been pulled inside the norm`);
}

// --------------------------------------------------------------------------- 3. classification
// Probed at every edge and a hair either side, because an off-by-one on an inclusive boundary is
// exactly the kind of thing that makes the strip and the VIX tile disagree about one session.
const eps = 0.01;
const probes = [];
for (const b of REGIME_BANDS) {
  for (const e of [b.lo, b.hi]) {
    if (e === null) continue;
    probes.push(e - eps, e, e + eps);
  }
}
probes.push(0, 1, 1000);
// EXACTLY ONE BAND MUST CLAIM EACH VALUE. Accepting "any band that matches" is what let the
// original ambiguity through: both calm and normal claimed 16, the table looked fine to a check
// that only asked whether regimeOf's answer was among the matches, and the answer it gave
// disagreed with the VIX tile. Two bands claiming one value is the bug, so it is the assertion.
for (const v of probes) {
  checks++;
  const hits = REGIME_BANDS.filter((b) => inBand(b, v));
  const got = regimeOf(v);
  if (hits.length === 0) {
    bad(`VIX ${v} is claimed by no band - the scale has a hole at that value`);
  } else if (hits.length > 1) {
    bad(`VIX ${v} is claimed by ${hits.map((h) => h.key).join(" and ")} - two bands own one value, so which one a session lands in depends on list order`);
  } else if (hits[0].key !== got) {
    bad(`VIX ${v} is ${hits[0].key} by the table, but regimeOf says "${got}"`);
  }
}
// And the edges specifically, spelled out, since those are the only values where it can go wrong.
for (const b of REGIME_BANDS) {
  for (const e of [b.lo, b.hi]) {
    if (e === null) continue;
    checks++;
    const owners = REGIME_BANDS.filter((x) => inBand(x, e)).map((x) => x.key);
    if (owners.length !== 1) {
      bad(`the edge ${e} is owned by ${owners.length} bands (${owners.join(", ") || "none"}) - set loInclusive/hiInclusive so exactly one side owns it`);
    }
  }
}
// The norm's edges are INCLUSIVE - the same rule the VIX tile colours by.
checks++;
if (regimeOf(VIX_BAND.high) !== "normal") {
  bad(`VIX exactly at the norm's top (${VIX_BAND.high}) is "${regimeOf(VIX_BAND.high)}", but the tile treats it as inside the band`);
}
checks++;
if (regimeOf(VIX_BAND.low) !== "normal") {
  bad(`VIX exactly at the norm's bottom (${VIX_BAND.low}) is "${regimeOf(VIX_BAND.low)}", but the tile treats it as inside the band`);
}

// --------------------------------------------------------------------------- 5. unknown
for (const v of [null, undefined, NaN, Infinity]) {
  checks++;
  if (regimeOf(v) !== "unknown") {
    bad(`regimeOf(${String(v)}) is "${regimeOf(v)}" - a row with no usable VIX must stay "unknown", never fold into a band`);
  }
}
checks++;
const counts = regimeCounts([{ vix: 12 }, { vix: 20 }, { vix: null }, {}]);
if (counts.unknown !== 2) bad(`regimeCounts counted ${counts.unknown} unknown rows out of 2`);

// --------------------------------------------------------------------------- geometry
// bandRects against a synthetic linear scale, so the clamping is exercised without a browser.
{
  const H = 100;
  // 0 -> y=100, 40 -> y=0. Prices outside that map outside the box.
  const toY = (price) => H - (price / 40) * H;
  const rects = bandRects(toY, 0, H);
  checks++;
  if (rects.some((r) => r.top < -0.01 || r.top + r.height > H + 0.01)) {
    bad(`a band escapes the plot: ${JSON.stringify(rects.map((r) => [r.key, r.top, r.height]))}`);
  }
  checks++;
  // Bands above the visible range must be dropped, not drawn flat.
  if (rects.some((r) => r.key === "extreme")) bad("the extreme band was drawn on a scale that tops out at 40");
  checks++;
  if (rects.length === 0) bad("no bands at all on a scale that clearly contains three of them");
  // And they must still meet where they are drawn.
  const sorted = [...rects].sort((a, b) => a.top - b.top);
  for (let i = 1; i < sorted.length; i++) {
    checks++;
    const gap = sorted[i].top - (sorted[i - 1].top + sorted[i - 1].height);
    if (Math.abs(gap) > 0.01) bad(`drawn bands ${sorted[i - 1].key} and ${sorted[i].key} are ${gap.toFixed(2)}px apart`);
  }
  checks++;
  if (bandRects(toY, 10, 10).length !== 0) bad("a zero-height plot produced bands");
}

// --------------------------------------------------------------------------- 4. somewhere to draw
const layout = read("app/layout.tsx");
const comp = read("components/MarketHistory.tsx");
const themeBlocks = [
  ["light", /:root\s*\{([\s\S]*?)\n\s*\}/],
  ["dark-media", /prefers-color-scheme:\s*dark[\s\S]*?\{\s*:root[^{]*\{([\s\S]*?)\n\s{4,}\}/],
  ["dark-attr", /:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\s*\}/],
];
for (const b of REGIME_BANDS) {
  const token = `--reg-${b.key}`;
  for (const [name, re] of themeBlocks) {
    checks++;
    const block = layout.match(re);
    if (!block) { bad(`could not find the ${name} theme block in app/layout.tsx`); continue; }
    if (!block[1].includes(`${token}:`)) {
      bad(`band "${b.key}" has no ${token} in the ${name} palette - it would paint as nothing`);
    }
  }
  checks++;
  if (!new RegExp(`\\.r-${b.key}\\s*\\{`).test(layout)) {
    bad(`band "${b.key}" has no .r-${b.key} class - its swatch and its tint have no colour`);
  }
  checks++;
  if (!new RegExp(`\\b${b.key}\\s*:\\s*theme\\.reg`).test(comp)) {
    bad(`band "${b.key}" is missing from the strip's colour map in MarketHistory.tsx - those sessions draw transparent, which on this chart means "no VIX published"`);
  }
}
checks++;
if (!/unknown\s*:\s*"rgba\(0,0,0,0\)"/.test(comp)) {
  bad("the strip's colour map has no transparent `unknown` - a session with no VIX would take a band's colour");
}

console.log(`  bands     ${REGIME_BANDS.map((b) => `${b.key} ${b.range}`).join(" | ")}`);
console.log(`  ${checks} assertions`);
if (problems.length > 0) {
  console.log();
  for (const p of problems) console.log("  FAILED    " + p);
  console.log(`\n  FAILED (${problems.length})`);
  process.exit(1);
}
console.log("  PASS      the scale tiles the number line and every band has a colour in both themes");
JS
