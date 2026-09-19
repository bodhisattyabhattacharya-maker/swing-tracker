#!/usr/bin/env bash
#
# scripts/ci/check_strip_sections.sh — every state the Deep Dive strip can be in must be visible.
#
# WHY THIS EXISTS, AND WHY IT IS A SECOND CHECK RATHER THAN A LINE IN THE FIRST ONE.
#
# `check_cell_states.sh` proves the GRID can render each of its eight cell states and that each has
# a CSS rule that can reach it. It cannot say anything about the strip, because the strip's rules are
# different selectors on different elements: the grid styles `td.st-below`, and a strip row is a
# `div`, so every one of the grid's state rules matches nothing in the Deep Dive tab.
#
# That is not a hypothetical. On 2026-09-18 this project shipped `tbody td.below` against a class
# that was really `st-below`: every judged cell in the grid drew its 2.5px rule with no colour and
# no tint, the page compiled, `next build` passed, CI passed, and it was invisible until the states
# were enumerated one at a time. CSS that matches nothing is an error at no layer of the toolchain.
# The strip is a new set of elements carrying the same class names, which is the same trap in a new
# room, so it gets the same lamp.
#
# WHAT IT CHECKS:
#   1. Both values of `SectionState` are produced by a real section in `SECTIONS`. A state that
#      exists only in the type is the `na` bug in a different shape. `SectionState` drives the
#      derivation and no longer drives any CSS, so it is checked for reachability only.
#   2. All three values of `SectionRender` occur, AND each has a CSS rule whose selector carries
#      `.ss-<render>`. That function decides whether a section shows data, a not-applicable
#      sentence or a blocked sentence; it is called by the component AND by this check, so the two
#      cannot disagree about what renders, and it is what the heading marker keys off - the first
#      version keyed the marker off `SectionState` and printed "planned" above a body reading
#      "Permanent, not pending" on every ETF.
#   4. Every cell state the strip can actually PRODUCE - computed by walking only the sections that
#      `sectionRender` says show DATA, against an exhaustive matrix of security and cell shapes, not
#      from a hand-written list - has a strip-scoped rule that carries `.st-<state>` AND SETS
#      `color`.
#   5. AND THE REVERSE: no strip-scoped rule exists for a state the strip cannot produce. This
#      direction was added when the first version of this check demanded a rule for `.st-na`, which
#      no strip element can carry - a section whose every param is inapplicable collapses to one
#      sentence, so `n·a` never reaches a cell there. A rule for an impossible state is the
#      2026-09-18 defect inverted, and it is what makes a stylesheet accumulate lies. When Phase 4
#      makes the fundamentals live, this is the direction that will speak up.
#
#      The colour requirement was forced by this check's own negative test. Deleting
#      `.dd-sec .st-below { color: var(--below) }` left the strip's judged values in ordinary ink,
#      and the first version of this check still passed - because `.dd-row.st-below::before`
#      survived, a rule that paints a 2.5px marker and nothing else. A rule existed; the state was
#      not legible. So "a rule can reach it" turned out to be the wrong question, and the question
#      is now "something sets its colour", which is how every state in the strip is actually
#      distinguished. A future state that is legitimately styled without colour will fail here and
#      should be given its own line, loudly, rather than silently weakening this one.
#   6. Loading `lib/deep-dive.ts` at all, which exercises its two module-load invariants: an unknown
#      param name, and a `why` that is missing on a planned section or stale on a live one.
#
# WHAT IT DOES NOT CHECK: whether a state occurs in PRODUCTION data, and whether it is the RIGHT
# state. Those are different questions and this is not the check for them.
#
# Deliberately node and grep rather than a headless browser: it must keep working when the
# toolchain changes, and it must be readable by someone who has never seen the project.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
web="$repo/web"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

for f in lib/deep-dive.ts lib/columns.ts app/layout.tsx; do
  if [ ! -f "$web/$f" ]; then
    echo "FAILED: web/$f not found - this check is looking in the wrong place"
    exit 1
  fi
done

# Plain CommonJS so node can require it with no bundler. `--skipLibCheck` because we are exercising
# this module's own shape, not the ambient DOM/Next types; `npm run build` is the real type gate.
if ! (cd "$web" && npx --no-install tsc lib/deep-dive.ts \
        --outDir "$out" --module commonjs --target es2020 --skipLibCheck >"$out/tsc.log" 2>&1); then
  echo "FAILED: could not compile web/lib/deep-dive.ts"
  cat "$out/tsc.log"
  exit 1
fi

node - "$out" "$web" <<'JS'
const fs = require("fs");
const path = require("path");
const out = process.argv[2];
const web = process.argv[3];

// Requiring the module runs its load-time invariants. A stale `why` on a section whose params have
// gone live throws HERE, which is the whole point of putting them at module load.
let mod;
try {
  mod = require(path.join(out, "deep-dive.js"));
} catch (e) {
  console.log(`  FAILED    lib/deep-dive.ts refused to load: ${e.message}`);
  process.exit(1);
}
const { RESOLVED, SECTIONS, sectionState, sectionRender } = mod;
const { cellState } = require(path.join(out, "columns.js"));

if (!Array.isArray(RESOLVED) || RESOLVED.length === 0) {
  console.log("  FAILED    RESOLVED is empty - this check would pass vacuously");
  process.exit(1);
}
if (RESOLVED.length !== SECTIONS.length) {
  console.log(`  FAILED    RESOLVED has ${RESOLVED.length} sections, SECTIONS has ${SECTIONS.length}`);
  process.exit(1);
}

let bad = 0;

// -------------------------------------------------------------------------
// 1. The declared section states, read from the SOURCE rather than retyped here. A state added to
//    the union with no way to reach it is exactly what this check is for, so the list must not be
//    a copy of the list it is checking.
// -------------------------------------------------------------------------
const src = fs.readFileSync(path.join(web, "lib", "deep-dive.ts"), "utf8");
const m = src.match(/export type SectionState =([^;]*);/);
if (!m) {
  console.log("  FAILED    could not find the SectionState union in web/lib/deep-dive.ts");
  process.exit(1);
}
const declaredSection = [...m[1].matchAll(/"([a-z-]+)"/g)].map((x) => x[1]);
if (declaredSection.length < 2) {
  console.log(`  FAILED    parsed only ${declaredSection.length} states from the SectionState union`);
  process.exit(1);
}

const sectionWitness = new Map();
for (const s of RESOLVED) {
  const st = sectionState(s);
  if (!sectionWitness.has(st)) sectionWitness.set(st, s.key);
}
for (const s of declaredSection) {
  if (sectionWitness.has(s)) {
    console.log(`  ok        section ${s.padEnd(8)} e.g. ${sectionWitness.get(s)}`);
  } else {
    console.log(`  FAILED    section ${s.padEnd(8)} declared in SectionState but no section produces it`);
    bad++;
  }
}
for (const s of sectionWitness.keys()) {
  if (!declaredSection.includes(s)) {
    console.log(`  FAILED    section ${s.padEnd(8)} produced by sectionState but absent from the union`);
    bad++;
  }
}

// -------------------------------------------------------------------------
// 2 and 3. Reachable is not the same as visible.
//
// CSS comments and the surrounding TSX line comments are stripped FIRST, and the selector must run
// from the class token to the brace that opens its block with nothing in between that would mean we
// had left the selector. The first version of the equivalent check in check_cell_states.sh asked
// only whether the string appeared anywhere in the file, which its own negative test passed by
// finding the class named in a comment. Prose must not be able to vouch for a rule.
// -------------------------------------------------------------------------
let css = fs.readFileSync(path.join(web, "app", "layout.tsx"), "utf8");
css = css.replace(/\/\*[\s\S]*?\*\//g, " ");
css = css.replace(/^\s*\/\/.*$/gm, " ");

for (const r of ["na", "blocked", "data"]) {
  const re = new RegExp(`\\.ss-${r}(?![a-z0-9-])[^{};]*\\{`);
  if (!re.test(css)) {
    console.log(`  FAILED    render  ${r.padEnd(8)} reachable, but app/layout.tsx has no rule whose selector carries .ss-${r}`);
    bad++;
  }
}

// Which cell states the strip can produce, derived from the sections' own params. Not a list: the
// point is that adding a param to a section cannot introduce a state with no styling.
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

// ALL THREE RENDER OUTCOMES MUST OCCUR. Each is a different sentence on screen; one that cannot
// happen is a branch nobody will ever read and a paragraph nobody will ever see.
const renderWitness = new Map();
for (const s of RESOLVED) {
  for (const sec of securities) {
    const r = sectionRender(s, sec);
    if (!renderWitness.has(r)) renderWitness.set(r, `${s.key}/${sec.symbol}`);
  }
}
for (const r of ["na", "blocked", "data"]) {
  if (renderWitness.has(r)) {
    console.log(`  ok        render  ${r.padEnd(8)} e.g. ${renderWitness.get(r)}`);
  } else {
    console.log(`  FAILED    render  ${r.padEnd(8)} no (section, security) pair produces it`);
    bad++;
  }
}

// Cell states, walking ONLY the sections that actually show data. A section that collapses to a
// sentence renders no cells, so its params' states are not reachable however cellState would
// classify them - that is exactly what made the first version of this check demand a rule for a
// state the strip cannot display.
const inStrip = new Map();
for (const s of RESOLVED) {
  for (const sec of securities) {
    if (sectionRender(s, sec) !== "data") continue;
    for (const col of s.columns) {
      for (const cell of cells) {
        const st = cellState(col, sec, cell);
        if (!inStrip.has(st)) inStrip.set(st, `${s.key}/${col.param}/${sec.symbol}`);
      }
    }
  }
}
if (inStrip.size === 0) {
  console.log("  FAILED    the sections produced no cell states at all - vacuous");
  bad++;
}

// Rules as (selector, block) pairs, so a rule can be asked what it DECLARES and not only what it
// selects. Crude on purpose - no @media or nested blocks in the strip's section of the stylesheet,
// and the assertion below is verified by its own negative tests rather than by trusting this split.
const rules = [];
for (const chunk of css.split("}")) {
  const i = chunk.indexOf("{");
  if (i === -1) continue;
  rules.push({ sel: chunk.slice(0, i), block: chunk.slice(i + 1) });
}

/**
 * Does this ONE selector colour the element that carries the state, inside the strip?
 *
 * Three conditions, and each of the last two was added because a negative test that should have
 * failed did not:
 *
 *   a. the selector mentions `.dd-`, so the grid's `td.st-below` cannot vouch for the strip;
 *   b. `.st-<state>` sits in the selector's FINAL compound - nothing after it but more classes on
 *      the same element. `.dd-sec .st-below .chip` styles a child, and a chip is not what most
 *      values render as, so it must not stand in for the value's own colour. Nor may
 *      `.dd-row.st-below::before`, which paints a 2.5px marker;
 *   c. the block sets `color`, not `background-color` or `border-color`. A tint behind a value is
 *      decoration; the ink is what makes the state legible.
 */
function coloursTheValue(sel, block, st) {
  if (!/\.dd-/.test(sel)) return false;
  const i = sel.search(new RegExp(`\\.st-${st}(?![a-z0-9-])`));
  if (i === -1) return false;
  const tail = sel.slice(i).replace(new RegExp(`^\\.st-${st}`), "");
  // A descendant, child, sibling or pseudo-element after the state class means the rule is about
  // something INSIDE the element, not about the element.
  if (/[\s>+~]/.test(tail) || tail.includes("::")) return false;
  return /(^|[;{\s])color\s*:/.test(block);
}

for (const [st, where] of [...inStrip].sort()) {
  let hit = null;
  let selectedOnly = null;
  for (const r of rules) {
    for (const one of r.sel.split(",")) {
      const sel = one.trim();
      if (!sel) continue;
      if (coloursTheValue(sel, r.block, st)) { hit = sel; break; }
      if (/\.dd-/.test(sel) && new RegExp(`\\.st-${st}(?![a-z0-9-])`).test(sel)) {
        selectedOnly = selectedOnly ?? sel;
      }
    }
    if (hit) break;
  }
  if (hit) {
    console.log(`  ok        cell    ${st.padEnd(8)} e.g. ${where}  <-  ${hit}`);
  } else {
    console.log(`  FAILED    cell    ${st.padEnd(8)} reachable in the strip (${where}), but nothing sets the colour of a strip element carrying .st-${st}`);
    if (selectedOnly) {
      console.log(`            The closest rule is  ${selectedOnly}  which either styles a child or`);
      console.log(`            sets no color. The state then selects and does not show, which is the failure mode.`);
    } else {
      console.log(`            The grid's td.st-${st} does not apply here: a strip row is a div.`);
    }
    bad++;
  }
}

// -------------------------------------------------------------------------
// 5. The reverse direction: a strip-scoped rule for a state the strip cannot produce.
//
// Every `.st-<x>` token that appears in a selector mentioning `.dd-`, checked against the reachable
// set. This is what stops the stylesheet keeping a rule for a state that stopped being possible -
// the inverse of the na cell-state bug, and the one that leaves comments and colours behind
// explaining a thing the page no longer does.
// -------------------------------------------------------------------------
const styled = new Map();
for (const r of rules) {
  for (const one of r.sel.split(",")) {
    const sel = one.trim();
    if (!/\.dd-/.test(sel)) continue;
    for (const mm of sel.matchAll(/\.st-([a-z-]+)/g)) {
      if (!styled.has(mm[1])) styled.set(mm[1], sel);
    }
  }
}
for (const [st, sel] of styled) {
  if (!inStrip.has(st)) {
    console.log(`  FAILED    dead    ${st.padEnd(8)} styled by  ${sel}  but no section that shows data can produce it`);
    console.log(`            Either make it reachable or delete the rule. A rule for an impossible state is a lie`);
    console.log(`            the stylesheet tells about the page, and it is how the 2026-09-18 defect happened backwards.`);
    bad++;
  }
}

process.exit(bad === 0 ? 0 : 1);
JS
rc=$?

if [ "$rc" -ne 0 ]; then
  echo "FAILED: see above"
  exit 1
fi
echo "  strip sections and cell states reachable and styled"
