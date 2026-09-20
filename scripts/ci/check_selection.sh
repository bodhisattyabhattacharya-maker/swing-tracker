#!/usr/bin/env bash
#
# scripts/ci/check_selection.sh — the Deep Dive selection comes out of the address bar, so it is
# untrusted input, and it must never be able to produce a strip with nothing in it.
#
# WHY THIS EXISTS
#
# Every other piece of state in this app arrives from the database through a typed view. This one
# arrives as a string a person can edit, truncate, or paste from a two-month-old message after the
# watchlist has changed. The failure that matters is not a crash — it is a link that renders four
# columns when it names five and says nothing, or one that renders an empty page that looks
# identical to a broken deploy.
#
# The rules the resolver has to hold, none of which are obvious from reading it:
#   * A selection naming nothing resolves to the DEFAULT, never to an empty strip.
#   * A selection naming only symbols we do not track also resolves to the default, and reports
#     what it dropped so the page can say so.
#   * A pinned symbol is shown whether or not it is also picked. `?pin=AVGO` alone is a reasonable
#     link and must not render blank.
#   * The order is pinned-first then picked, with no symbol appearing twice however the URL
#     repeats it.
#   * The default is EVERY bellwether, which is a config fact and not a ranking - and not one per
#     theme, which is what this check was written assuming until it counted: ai-silicon names both
#     AVGO and NVDA, mega-cap-tech both AAPL and MSFT.
#   * A round trip through serialise/parse changes nothing, or a replaceState would rewrite the
#     reader's URL into something that means something else.
#   * The whole thing is bounded, because MAX_PICKED is the only thing standing between a pasted
#     URL and building 53 sections per column for ten thousand columns.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
web="$repo/web"

if [ ! -f "$web/lib/selection.ts" ]; then
  echo "FAILED: $web/lib/selection.ts not found - this check is looking in the wrong place"
  exit 1
fi

node --experimental-strip-types - "$web" <<'JS' 2>&1 | grep -v "ExperimentalWarning\|--trace-warnings\|MODULE_TYPELESS\|Reparsing\|performance overhead\|add \"type\""
import path from "node:path";
const web = process.argv[2];

const problems = [];
const bad = (m) => problems.push(m);
let checks = 0;
const eq = (name, got, want) => {
  checks++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) bad(`${name}: got ${g}, expected ${w}`);
};

const m = await import(path.join(web, "lib/selection.ts"));
const {
  parseSelection, serialiseSelection, resolveSelection, defaultColumns,
  pick, drop, togglePin, MAX_PICKED, EMPTY_SELECTION,
} = m;

// A stand-in watchlist with the shapes that matter: several themes, a bellwether in each, one
// theme with no bellwether at all, and a fund.
const SECS = [
  { symbol: "AVGO", name: "Broadcom", theme: "ai_silicon", bellwether: true, is_fund: false, rankable: true },
  { symbol: "NVDA", name: "NVIDIA", theme: "ai_silicon", bellwether: false, is_fund: false, rankable: true },
  { symbol: "AAPL", name: "Apple", theme: "megacap", bellwether: true, is_fund: false, rankable: true },
  // TWO BELLWETHERS IN ONE THEME, because that is what config/watchlist.yml actually has: both
  // ai-silicon and mega-cap-tech name two. The stand-in assumed one per theme until 2026-09-20
  // and the assumption was wrong in two of seven real themes.
  { symbol: "MSFT", name: "Microsoft", theme: "megacap", bellwether: true, is_fund: false, rankable: true },
  { symbol: "SPY", name: "SPDR S&P 500", theme: "etfs", bellwether: true, is_fund: true, rankable: false },
  { symbol: "QQQ", name: "Invesco QQQ", theme: "etfs", bellwether: false, is_fund: true, rankable: false },
  // A theme whose config names no bellwether. It must contribute nothing to the default rather
  // than an arbitrary member - picking one would be the product choosing a representative.
  { symbol: "ARM", name: "Arm Holdings", theme: "foundry", bellwether: false, is_fund: false, rankable: true },
];
const syms = (list) => list.map((s) => s.symbol);

// --------------------------------------------------------------------------- the default
{
  const d = defaultColumns(SECS);
  eq("default is every bellwether, including two from one theme", syms(d), ["AVGO", "AAPL", "MSFT", "SPY"]);
  checks++;
  if (d.some((s) => !s.bellwether)) bad("a non-bellwether reached the default view");
  checks++;
  // The count is measured from the data, not hard-coded, so adding a bellwether to the real
  // watchlist changes the default rather than tripping a check that asserted a number.
  if (d.length !== SECS.filter((s) => s.bellwether).length) {
    bad(`the default has ${d.length} columns but ${SECS.filter((s) => s.bellwether).length} names are bellwethers - a theme's second bellwether is being dropped`);
  }
  checks++;
  if (d.some((s) => s.theme === "foundry")) {
    bad("the bellwether-less theme contributed a column to the default - the product picked a representative");
  }
  const r = resolveSelection(SECS, EMPTY_SELECTION);
  eq("an empty selection resolves to the default", syms(r.columns), ["AVGO", "AAPL", "MSFT", "SPY"]);
  eq("and says it is the default", r.isDefault, true);
}

// --------------------------------------------------------------------------- never empty
{
  const r = resolveSelection(SECS, parseSelection("?s=NOPE,ZZZZ"));
  eq("a link naming only unknowns falls back to the default", syms(r.columns), ["AVGO", "AAPL", "MSFT", "SPY"]);
  eq("and reports what it could not find", r.unknown.sort(), ["NOPE", "ZZZZ"]);
  eq("and admits it is showing the default", r.isDefault, true);
  checks++;
  if (r.columns.length === 0) bad("a stale link produced an empty strip");
}
for (const q of ["", "?", "?s=", "?s=,,,", "?pin=", "?x=1", "?s=%%%", "?s=" + "&".repeat(50)]) {
  checks++;
  const r = resolveSelection(SECS, parseSelection(q));
  if (r.columns.length === 0) bad(`the query ${JSON.stringify(q)} produced an empty strip`);
}

// --------------------------------------------------------------------------- pin behaviour
{
  const r = resolveSelection(SECS, parseSelection("?pin=AVGO"));
  eq("a pin-only link shows the pinned name", syms(r.columns), ["AVGO"]);
  eq("and is not the default", r.isDefault, false);
}
{
  const r = resolveSelection(SECS, parseSelection("?s=NVDA,AAPL,MSFT&pin=MSFT"));
  eq("pinned first, then picked order", syms(r.columns), ["MSFT", "NVDA", "AAPL"]);
}
{
  const r = resolveSelection(SECS, parseSelection("?s=AVGO,AVGO,NVDA&pin=AVGO"));
  eq("no symbol appears twice however the URL repeats it", syms(r.columns), ["AVGO", "NVDA"]);
}
{
  const r = resolveSelection(SECS, parseSelection("?s=nvda,Avgo"));
  eq("case does not matter", syms(r.columns), ["NVDA", "AVGO"]);
}

// --------------------------------------------------------------------------- order is honoured
{
  const a = syms(resolveSelection(SECS, parseSelection("?s=NVDA,AVGO")).columns);
  const b = syms(resolveSelection(SECS, parseSelection("?s=AVGO,NVDA")).columns);
  eq("picked order is the column order", a, ["NVDA", "AVGO"]);
  eq("and reversing the link reverses the strip", b, ["AVGO", "NVDA"]);
  checks++;
  if (JSON.stringify(a) === JSON.stringify(b)) {
    bad("the two orders produced the same strip - selection order is being ignored");
  }
}

// --------------------------------------------------------------------------- bounded
{
  // AN ABSOLUTE CEILING, NOT THE CONSTANT ITSELF. Asserting `parsed.length <= MAX_PICKED` is
  // vacuous: raising MAX_PICKED to 100000 satisfies it, which a negative test proved by passing.
  // The bound exists to keep a pasted URL from building eight sections per column for thousands
  // of columns, so the thing to assert is that the bound is small enough to do that job.
  const SANE = 200;
  checks++;
  if (!(MAX_PICKED > 0 && MAX_PICKED <= SANE)) {
    bad(`MAX_PICKED is ${MAX_PICKED}; it must be a real bound (1..${SANE}) or it is not protecting anything - the watchlist is ~53 names`);
  }
  const many = Array.from({ length: 5000 }, (_, i) => `SYM${i}`).join(",");
  const parsed = parseSelection("?s=" + many);
  checks++;
  if (parsed.picked.length > SANE) {
    bad(`a 5000-symbol URL parsed to ${parsed.picked.length} symbols, past any sane ceiling`);
  }
  checks++;
  const r = resolveSelection(SECS, parsed);
  if (r.columns.length > SECS.length) bad("more columns than there are securities");
}
{
  // Junk that is not a ticker never reaches a lookup.
  const parsed = parseSelection("?s=<script>,../../etc,A B C,AVGO");
  eq("only ticker-shaped strings survive parsing", parsed.picked, ["AVGO"]);
}

// --------------------------------------------------------------------------- round trip
for (const q of [
  "?s=AVGO,NVDA", "?pin=AVGO", "?s=NVDA,AAPL&pin=MSFT", "?s=AVGO,AVGO", "", "?s=nvda",
]) {
  checks++;
  const once = parseSelection(q);
  const text = serialiseSelection(once);
  const twice = parseSelection(text);
  if (JSON.stringify(once) !== JSON.stringify(twice)) {
    bad(`round trip changed ${JSON.stringify(q)}: ${JSON.stringify(once)} -> ${text} -> ${JSON.stringify(twice)}`);
  }
}
eq("the default serialises to nothing, so a bare URL keeps meaning the default",
   serialiseSelection(EMPTY_SELECTION), "");
checks++;
if (serialiseSelection({ picked: ["AVGO", "NVDA"], pinned: [] }).includes("%2C")) {
  bad("commas are percent-encoded - the URL is meant to be read and edited by a person");
}

// --------------------------------------------------------------------------- the editing verbs
{
  // The first click on a default strip ADDS. Replacing nine visible columns with one would be a
  // different verb than the one the reader used.
  const after = pick(EMPTY_SELECTION, "NVDA", SECS);
  eq("picking from the default keeps what was on screen",
     syms(resolveSelection(SECS, after).columns), ["AVGO", "AAPL", "MSFT", "SPY", "NVDA"]);
  const gone = drop(EMPTY_SELECTION, "AAPL", SECS);
  eq("removing from the default removes only that one",
     syms(resolveSelection(SECS, gone).columns), ["AVGO", "MSFT", "SPY"]);
  const pinnedNow = togglePin(EMPTY_SELECTION, "SPY", SECS);
  eq("pinning from the default moves it left and keeps the rest",
     syms(resolveSelection(SECS, pinnedNow).columns), ["SPY", "AVGO", "AAPL", "MSFT"]);
  // Unpin is not delete. This is the one that would be easy to get wrong and hard to notice.
  const back = togglePin(pinnedNow, "SPY", SECS);
  checks++;
  if (!syms(resolveSelection(SECS, back).columns).includes("SPY")) {
    bad("unpinning removed the column instead of returning it to the order");
  }
  eq("dropping every column still cannot empty the strip",
     resolveSelection(SECS, SECS.reduce((acc, s) => drop(acc, s.symbol, SECS), EMPTY_SELECTION))
       .columns.length > 0, true);
}

console.log(`  model     default ${defaultColumns(SECS).length} of ${SECS.length} stand-in names, bound ${MAX_PICKED}`);
console.log(`  ${checks} assertions`);
if (problems.length > 0) {
  console.log();
  for (const p of problems) console.log("  FAILED    " + p);
  console.log(`\n  FAILED (${problems.length})`);
  process.exit(1);
}
console.log("  PASS      no URL produces an empty strip, order is honoured, and the round trip is lossless");
JS
