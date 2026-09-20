#!/usr/bin/env bash
#
# scripts/ci/check_contrast.sh — the palette must be legible, complete, and the same in both themes.
#
# WHY THIS EXISTS
#
# On 2026-09-19 the verdict pair was reversed from blue/ochre to muted red/green (decision 0052) and
# the whole warm Atelier palette landed with it. A palette change is a uniquely quiet kind of change:
# nothing fails to compile, no test goes red, the page renders, and the defect - a tint that is
# unreadable against its own text, or a token that exists in light and not in dark - is discovered by
# a person squinting at a screenshot, if at all. Three of this project's shipped defects were of
# exactly that shape, and the lesson written down after each of them was the same: enumerate what can
# actually happen rather than reasoning about it.
#
# So this check resolves the stylesheet's tokens the way a browser would, in BOTH themes, and
# measures every foreground/background pairing the CSS can produce.
#
# WHAT IT CHECKS
#   1. The three token blocks exist and parse: `:root`, the `prefers-color-scheme: dark` block, and
#      `:root[data-theme="dark"]`.
#   2. THE TWO DARK BLOCKS ARE IDENTICAL. They are a hand-maintained duplicate - one serves the OS
#      preference, the other the explicit toggle - and a token that drifts between them means the
#      toggle and the OS produce different pages from the same choice. Nothing else would catch it:
#      most viewing happens through one path only.
#   3. Every `var(--x)` used anywhere in the stylesheet is defined in `:root`. An undefined custom
#      property does not throw; it resolves to nothing and the declaration is dropped, which is how a
#      colour becomes "whatever was inherited" without a word of warning.
#   4. Every token redefined for dark is one that is actually used. A dark override for a token
#      nothing references is dead weight that reads as coverage.
#   5. CONTRAST. Every rule that sets `color` is measured against the background it can sit on - the
#      one it sets itself if it sets one, otherwise the three container surfaces - in both themes,
#      and anything under 4.5:1 fails. 4.5 is the AA floor for normal text and this page's labels run
#      from 9px to 13px, so the large-text allowance of 3:1 does not apply to them.
#   6. Every group in `lib/columns.ts` GROUPS has a rail rule in the stylesheet, and the token that
#      rule names is defined. The group heading is rendered with className={g.key}, so a group added
#      there with no rule here simply gets no rail - silent, and the exact shape of the three defects
#      named above.
#   7. `lib/chart-theme.ts`'s FALLBACK matches the `:root` block value for value, and every name in
#      its TOKENS map exists. That file's own header has claimed since it was written that "the check
#      below fails the build if these drift from the stylesheet". Until today no such check existed.
#      This is it.
#
# WHAT IT CANNOT CHECK, stated so the coverage is not overread: it resolves colours statically, so a
# background painted by an ancestor the selector does not name is out of its reach, as is anything
# translucent - `color-mix`, `rgba` over an unknown backdrop - which it skips rather than guesses at.
# The screenshot harness remains the thing that looks at the page.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
web="$repo/web"

for f in app/layout.tsx lib/columns.ts lib/chart-theme.ts; do
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

// --------------------------------------------------------------------------- the stylesheet
const layout = read("app/layout.tsx");
// GREEDY TO THE LAST BACKTICK, THEN NO BACKTICK ALLOWED INSIDE, and this replaced a non-greedy
// match on 2026-09-20 after it hid a real failure.
//
// The stylesheet is one template literal. A backtick written inside a CSS comment - which is easy
// to do, because backticks are how one quotes an identifier in the prose everywhere else in this
// repo - ends that literal early. The compiler catches it eventually, with a message pointing at
// a CSS comment and complaining about a missing semicolon.
//
// The non-greedy version agreed with the stray backtick and captured only the CSS before it.
// Measured, on a stray inserted at line 417: the check went from 548 pairings to 102 and then
// reported 31 failures, all of them variations on "this token is not defined in :root" - true of
// the fragment it was looking at, false of the stylesheet, and pointing nowhere near the cause.
// Loud but misdirecting, which costs more than silence because it sends you to fix 31 things
// that are not broken. (A stray NOT followed by a semicolon did not truncate at all, so the old
// regex failed unpredictably rather than always.) Greedy takes the whole literal; the assertion
// below then names the one real problem in one line.
const lit = layout.match(/const CSS = `([\s\S]*)`;/);
if (!lit) {
  console.log("FAILED: could not find the CSS template literal in app/layout.tsx");
  process.exit(1);
}
if (lit[1].includes("`")) {
  const line = layout.slice(0, layout.indexOf("`", layout.indexOf("const CSS = `") + 13)).split("\n").length;
  console.log(
    `FAILED: a backtick appears inside the CSS template literal, near app/layout.tsx:${line}. ` +
      `It ends the literal early and breaks the whole file; the compiler reports it as a missing ` +
      `semicolon in a CSS comment. Write the identifier without backticks.`,
  );
  process.exit(1);
}
// Comments stripped first, so prose about a colour can never vouch for a rule that sets one. The
// same precaution check_strip_sections.sh takes, for the same reason.
const css = lit[1].replace(/\/\*[\s\S]*?\*\//g, " ");

function tokenBlock(re, what) {
  const b = css.match(re);
  if (!b) {
    bad(`the ${what} token block was not found in app/layout.tsx`);
    return null;
  }
  const out = {};
  for (const d of b[1].matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim();
  return out;
}
const light = tokenBlock(/:root\s*\{([\s\S]*?)\}/, "light (:root)");
const darkAuto = tokenBlock(/:root:not\(\[data-theme="light"\]\)\s*\{([\s\S]*?)\}/, "dark (media query)");
const darkExpl = tokenBlock(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\}/, 'dark ([data-theme="dark"])');
if (!light || !darkAuto || !darkExpl) {
  for (const p of problems) console.log("  FAILED    " + p);
  process.exit(1);
}
console.log(
  `  tokens    light ${Object.keys(light).length}  dark-media ${Object.keys(darkAuto).length}  ` +
    `dark-attr ${Object.keys(darkExpl).length}`,
);

// --------------------------------------------------------------------------- 2. the dark twins
for (const k of new Set([...Object.keys(darkAuto), ...Object.keys(darkExpl)])) {
  checks++;
  if (!(k in darkAuto)) {
    bad(`--${k} is set by :root[data-theme="dark"] but not by the media-query block - the toggle and the OS would produce different pages`);
  } else if (!(k in darkExpl)) {
    bad(`--${k} is set by the media-query block but not by :root[data-theme="dark"] - the toggle would not move it`);
  } else if (darkAuto[k] !== darkExpl[k]) {
    bad(`--${k} disagrees between the two dark blocks: ${darkAuto[k]} vs ${darkExpl[k]}`);
  }
}

// --------------------------------------------------------------------------- 3 & 4. completeness
const referenced = new Set([...css.matchAll(/var\(\s*--([a-z0-9-]+)/g)].map((x) => x[1]));
for (const t of [...referenced].sort()) {
  checks++;
  if (!(t in light)) bad(`var(--${t}) is used but never defined in :root - it resolves to nothing and the declaration is dropped`);
}
for (const t of Object.keys(darkAuto).sort()) {
  checks++;
  if (!referenced.has(t)) bad(`--${t} is redefined for dark but no rule uses it`);
}

// --------------------------------------------------------------------------- colour maths
function rgb(value, tokens, seen = new Set()) {
  const v = String(value).trim();
  const ref = v.match(/^var\(\s*--([a-z0-9-]+)\s*\)?/);
  if (ref) {
    if (seen.has(ref[1])) return null;                 // a cycle; nothing sensible to return
    seen.add(ref[1]);
    return tokens[ref[1]] ? rgb(tokens[ref[1]], tokens, seen) : null;
  }
  const hex6 = v.match(/^#([0-9a-f]{6})\b/i);
  if (hex6) return [0, 2, 4].map((i) => parseInt(hex6[1].slice(i, i + 2), 16));
  const hex3 = v.match(/^#([0-9a-f]{3})\b/i);
  if (hex3) return [...hex3[1]].map((c) => parseInt(c + c, 16));
  const fn = v.match(/^rgba?\(([^)]+)\)/);
  if (fn) {
    const p = fn[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    // Anything translucent is skipped rather than composited against a guess - see the header.
    if (p.length >= 4 && p[3] < 0.999) return null;
    if (p.length >= 3 && p.slice(0, 3).every(Number.isFinite)) return p.slice(0, 3);
  }
  return null;                                         // transparent, none, gradients, color-mix
}
const chan = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
function contrast(a, b) {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// --------------------------------------------------------------------------- 5. contrast
// Every rule that paints text, with the background it declares if it declares one.
const rules = [];
for (const r of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const sel = r[1].trim().split("\n").map((s) => s.trim()).join(" ");
  if (/^(:root|@|\s*$)/.test(sel)) continue;
  const fg = r[2].match(/(?:^|[;{\s])color\s*:\s*([^;]+)/);
  if (!fg) continue;
  const bg = r[2].match(/(?:^|[;{\s])background(?:-color)?\s*:\s*([^;]+)/);
  rules.push({ sel, fg: fg[1].trim(), bg: bg ? bg[1].trim() : null });
}
if (rules.length === 0) bad("no rule in the stylesheet sets a colour - this check parsed nothing and proved nothing");

// The three surfaces a run of text with no background of its own can be sitting on: the panel, the
// page behind it, and the tint a hovered row or a band paints. Checking all three rather than the
// lightest is the point - the failure is always the worst pairing, and the worst pairing is the one
// nobody screenshots.
const SURFACES = ["--surface", "--paper", "--rule-soft"];
const FLOOR = 4.5;
const failures = [];
let measured = 0;

for (const [theme, tokens] of [["light", light], ["dark", { ...light, ...darkAuto }]]) {
  for (const r of rules) {
    const f = rgb(r.fg, tokens);
    if (!f) continue;
    const grounds = r.bg ? [[r.bg, rgb(r.bg, tokens)]] : SURFACES.map((s) => [s, rgb(`var(${s})`, tokens)]);
    for (const [label, g] of grounds) {
      if (!g) continue;
      measured++;
      checks++;
      const c = contrast(f, g);
      if (c < FLOOR) failures.push({ theme, sel: r.sel, fg: r.fg, bg: label, c: c.toFixed(2) });
    }
  }
}
console.log(`  contrast  ${measured} pairings measured across two themes, floor ${FLOOR}:1`);
for (const f of failures) {
  bad(`${f.theme}: ${f.fg} on ${f.bg} is ${f.c}:1, under ${FLOOR} — ${f.sel}`);
}

// --------------------------------------------------------------------------- 6. group rails
const columns = read("lib/columns.ts");
const groupsBlock = columns.match(/export const GROUPS:\s*Group\[\]\s*=\s*\[([\s\S]*?)\n\];/);
if (!groupsBlock) {
  bad("could not find the GROUPS array in lib/columns.ts - the rail check ran over nothing");
} else {
  const keys = [...groupsBlock[1].matchAll(/key:\s*"([^"]+)"/g)].map((m) => m[1]);
  if (keys.length === 0) bad("GROUPS parsed to zero groups - the rail check ran over nothing");
  console.log(`  rails     ${keys.length} groups in lib/columns.ts`);
  for (const k of keys) {
    checks++;
    // The selector the component produces: thead tr.grp th with the group key as its class.
    const re = new RegExp(`thead\\s+tr\\.grp\\s+th\\.${k}(?![a-z0-9-])[^{]*\\{([^}]*)\\}`, "i");
    const m = css.match(re);
    if (!m) {
      bad(`group "${k}" is in GROUPS but no rule matches thead tr.grp th.${k} - that band gets no rail and nothing says so`);
      continue;
    }
    const tok = m[1].match(/var\(\s*--([a-z0-9-]+)/);
    if (!tok) bad(`the rail rule for group "${k}" names no token`);
    else if (!(tok[1] in light)) bad(`the rail rule for group "${k}" uses var(--${tok[1]}), which is not defined`);
  }
}

// --------------------------------------------------------------------------- 7b. tile scales
// A market tile declares which SCALE its verdict is read on: the ordinary red/green verdict pair,
// or the calm/stressed intensity pair VIX uses. Each scale paints two classes, and both directions
// must be checked BOTH WAYS - a scale whose rules are missing paints nothing, and a rule for a
// scale no tile declares is dead CSS that reads as coverage. This project has shipped the first
// three times and the second once; they are the same defect facing opposite directions.
{
  const market = read("lib/market.ts");
  const tiles = market.match(/export const MARKET_TILES[^=]*=\s*\[([\s\S]*?)\n\];/);
  if (!tiles) {
    bad("could not find MARKET_TILES in lib/market.ts - the tile-scale check ran over nothing");
  } else {
    const entries = [...tiles[1].matchAll(/\{[\s\S]*?\}/g)].map((m) => m[0]);
    if (entries.length === 0) bad("MARKET_TILES parsed to zero tiles - the tile-scale check ran over nothing");
    const used = new Set(
      entries.map((e) => (e.match(/scale:\s*"([a-z]+)"/) || [, "verdict"])[1]),
    );
    const CLASSES = { verdict: ["below", "above"], intensity: ["calm", "stress"] };
    console.log(`  tiles     ${entries.length} tiles on ${[...used].sort().join(" + ")}`);
    for (const [scale, classes] of Object.entries(CLASSES)) {
      for (const c of classes) {
        checks++;
        // A rule that SETS color, not merely a selector mentioning the class. Deleting
        // `.tile.stress { background; color }` left `.tile.stress::before` behind, and the first
        // version of this check was satisfied by that 2.5px rule - the tile would have carried a
        // coloured edge and ordinary ink. The same correction check_strip_sections.sh needed, for
        // the same reason, one surface over.
        const has = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].some(
          (m) =>
            new RegExp(`\\.tile\\.${c}(?![a-z0-9-])(?![^,{]*::)`).test(m[1]) &&
            /(^|[;{\s])color\s*:/.test(m[2]),
        );
        if (used.has(scale) && !has) {
          bad(`a tile declares scale "${scale}" but no .tile.${c} rule sets a colour - that tile paints nothing`);
        }
        if (!used.has(scale) && has) {
          bad(`.tile.${c} exists but no tile declares scale "${scale}" - no tile can reach that rule`);
        }
      }
    }
  }
}

// --------------------------------------------------------------------------- 7. the chart fallback
const chartTheme = read("lib/chart-theme.ts");
const tokMap = chartTheme.match(/const TOKENS:[^=]*=\s*\{([\s\S]*?)\n\};/);
const fbMap = chartTheme.match(/const FALLBACK:\s*ChartTheme\s*=\s*\{([\s\S]*?)\n\};/);
if (!tokMap || !fbMap) {
  bad("could not parse TOKENS or FALLBACK out of lib/chart-theme.ts");
} else {
  const names = Object.fromEntries([...tokMap[1].matchAll(/(\w+):\s*"(--[a-z0-9-]+)"/g)].map((m) => [m[1], m[2]]));
  const values = Object.fromEntries([...fbMap[1].matchAll(/(\w+):\s*"(#[0-9a-f]{3,8})"/gi)].map((m) => [m[1], m[2].toLowerCase()]));
  console.log(`  charts    ${Object.keys(names).length} tokens mapped, ${Object.keys(values).length} fallback values`);
  for (const [key, prop] of Object.entries(names)) {
    checks++;
    const cssName = prop.slice(2);
    if (!(cssName in light)) {
      bad(`lib/chart-theme.ts maps ${key} to ${prop}, which app/layout.tsx does not define - the charts would draw in invisible ink`);
      continue;
    }
    if (!(key in values)) {
      bad(`lib/chart-theme.ts maps ${key} to ${prop} but FALLBACK has no value for it`);
      continue;
    }
    if (values[key] !== light[cssName].toLowerCase()) {
      bad(`FALLBACK.${key} is ${values[key]} but ${prop} is ${light[cssName]} - the server-render palette has drifted from the stylesheet`);
    }
  }
  for (const key of Object.keys(values)) {
    checks++;
    if (!(key in names)) bad(`FALLBACK.${key} has no entry in TOKENS, so nothing ever reads it from the page`);
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
console.log("  PASS      palette complete in both themes, every pairing at or above the floor");
JS
