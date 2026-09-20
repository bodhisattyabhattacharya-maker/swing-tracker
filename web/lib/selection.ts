/**
 * selection.ts — which securities the Deep Dive strip shows, and in what order.
 *
 * PURE, AND WITH NO RUNTIME IMPORTS AT ALL. `lib/deep-dive.ts` next door imports `lib/columns.ts`
 * for the section catalogue, which is fine in the bundler and fatal to a plain `node` process:
 * the specifier has no extension, so `scripts/ci/check_selection.sh` could not load it without a
 * resolver hook. This module takes only a type, which the type stripper erases, so the check runs
 * the real code rather than a transpiled copy of it.
 *
 * That is not the only reason to split it. `deep-dive.ts` answers "what is in a column"; this
 * answers "which columns, in what order". They changed for different reasons in three of the last
 * four stages.
 *
 * ---------------------------------------------------------------------------
 * THE SELECTION LIVES IN THE URL (decision 0055)
 *
 * 53 names at 420px is 22,260px of horizontal scroll. That is expected — the strip is a comparison
 * surface and its columns are deliberately never allowed to reflow — but it is not a starting
 * position. The picker narrows it, and the picked set goes in the query string so a view is
 * shareable and survives a reload.
 *
 * The query string is read in the browser after mount, NOT through the framework's `searchParams`,
 * because that would mark `/deep-dive` dynamic and every visitor would pay for a server render.
 * The page stays statically prerendered on its 15-minute revalidate. The cost is one reflow when a
 * link carries a selection.
 *
 * ---------------------------------------------------------------------------
 * IT IS UNTRUSTED INPUT
 *
 * Every other piece of state in this app arrives from the database through a typed view. This one
 * is a string a person can edit, truncate, or paste from a message sent before the watchlist
 * changed. So: symbols are shape-checked before any lookup, the list is bounded, and **no input
 * can produce an empty strip** — a blank page is indistinguishable from a broken deploy, so an
 * unrecognised link falls back to the default and says what it dropped.
 */

/** A security as the strip needs to know it. */
export interface StripSecurity {
  symbol: string;
  is_fund: boolean;
  rankable: boolean;
  name: string;
  theme: string;
  bellwether: boolean;
}

/**
 * The order the columns appear in.
 *
 * Bellwethers first within a theme, then alphabetically, and themes in the order the ticker read
 * already returned them. NOT sorted by any parameter: this product has no score and no ranking
 * (hard constraint 1), and a strip ordered by RSI would be a ranking with extra steps. The theme
 * grouping is the only ordering that carries no verdict.
 */
export function stripOrder(secs: StripSecurity[]): StripSecurity[] {
  const themeRank = new Map<string, number>();
  for (const s of secs) if (!themeRank.has(s.theme)) themeRank.set(s.theme, themeRank.size);
  return secs.slice().sort((a, b) =>
    (themeRank.get(a.theme) ?? 99) - (themeRank.get(b.theme) ?? 99) ||
    Number(b.bellwether) - Number(a.bellwether) ||
    a.symbol.localeCompare(b.symbol)
  );
}

/** Where a theme changes, so the strip can rule between blocks the way the grid bands its rows. */
export function themeStarts(secs: StripSecurity[]): Set<string> {
  return new Set(
    secs.filter((s, i) => i === 0 || s.theme !== secs[i - 1].theme).map((s) => s.symbol),
  );
}

// ---------------------------------------------------------------------------
// WHICH COLUMNS THE STRIP SHOWS, AND IN WHAT ORDER (decision 0055).
//
// 53 names at 420px is 22,260px of horizontal scroll. That is expected — the strip is a
// comparison surface and columns are deliberately never allowed to reflow — but it is not a
// starting position. The picker narrows it; this module is the part of the picker that has no
// DOM in it.
//
// THE SELECTION LIVES IN THE URL, and the reason is not only that a view becomes shareable. The
// Deep Dive page is statically prerendered with a 15-minute revalidate. Reading the selection
// through the framework's `searchParams` would mark the route dynamic and every viewer would
// render it fresh, so the page is served static and `StockStrip` reads `window.location` after
// mount instead. The cost is one reflow when a link carries a selection; the alternative was
// paying for a server render on every visit to move some columns around.
//
// PURE. Parsing, defaulting and ordering are all here, testable without a browser, because a
// hand-edited URL is untrusted input and the interesting cases are all malformed ones.
// ---------------------------------------------------------------------------

/** `?s=` — the picked symbols, in the order they were picked. */
export const SELECT_PARAM = "s";
/** `?pin=` — the pinned symbols, in pin order. A pinned symbol is picked whether or not it is in `s`. */
export const PIN_PARAM = "pin";

/**
 * How many symbols a URL may name.
 *
 * Not a guess about taste — a bound on untrusted input. The strip renders eight sections per
 * column and a hand-typed or truncated URL naming ten thousand symbols would build that DOM
 * before anyone could stop it. 53 is the whole universe, so anything beyond it is already wrong.
 */
export const MAX_PICKED = 60;

export interface Selection {
  /** Picked symbols in order. Empty means "no selection", which resolves to the default. */
  picked: string[];
  /** Pinned symbols in pin order. Always a subset of what gets rendered. */
  pinned: string[];
}

export const EMPTY_SELECTION: Selection = { picked: [], pinned: [] };

/** Split a comma list into clean, unique, upper-case symbols. Order of first appearance wins. */
function symbolList(raw: string | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const s = part.trim().toUpperCase();
    // Symbols are letters, digits, dot and dash. Anything else is not a ticker and is dropped
    // rather than passed through to a lookup — this string came from an address bar.
    if (!s || !/^[A-Z0-9.\-]{1,12}$/.test(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_PICKED) break;
  }
  return out;
}

/** Read a selection out of a query string, e.g. `?s=AVGO,NVDA&pin=AVGO`. */
export function parseSelection(search: string): Selection {
  let q: URLSearchParams;
  try {
    q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  } catch {
    // A malformed query string is a no-op, not a crash. The default view is always valid.
    return EMPTY_SELECTION;
  }
  return { picked: symbolList(q.get(SELECT_PARAM)), pinned: symbolList(q.get(PIN_PARAM)) };
}

/**
 * The query string for a selection, including the leading `?`, or `""` for the default.
 *
 * The default serialises to nothing rather than to the nine bellwethers spelled out. A bare
 * `/deep-dive` has to keep meaning "the default", so that if the default ever changes an old
 * bookmark follows it instead of pinning yesterday's answer.
 */
export function serialiseSelection(sel: Selection): string {
  const q = new URLSearchParams();
  if (sel.picked.length > 0) q.set(SELECT_PARAM, sel.picked.join(","));
  if (sel.pinned.length > 0) q.set(PIN_PARAM, sel.pinned.join(","));
  const s = q.toString();
  // URLSearchParams percent-encodes the commas; they are legal unencoded in a query value and the
  // URL is meant to be read and edited by a person.
  return s ? "?" + s.replace(/%2C/g, ",") : "";
}

/**
 * The default columns: every bellwether, in the strip's own theme order.
 *
 * EVERY bellwether, not one per theme — that was the assumption and it is wrong. Counted against
 * `config/watchlist.yml`: 9 bellwethers across 7 themes, because ai-silicon has both AVGO and
 * NVDA and mega-cap-tech has both AAPL and MSFT. Taking one per theme would mean this module
 * choosing between two names the config treats as equals, which is precisely the kind of
 * judgement the next paragraph says it must not make.
 *
 * BELLWETHER IS A CONFIG FACT, NOT A JUDGEMENT. It is declared in `config/watchlist.yml`, so
 * defaulting to the bellwethers ranks nothing and computes nothing — it is the same claim the ◆
 * on the Dashboard already makes. Hard constraint 1 rules out the PRODUCT ordering names by a
 * parameter; it does not rule out the product reading its own config.
 *
 * A theme with no bellwether contributes nothing rather than an arbitrary member, for the same
 * reason: picking a representative would be the product choosing one.
 */
export function defaultColumns(secs: StripSecurity[]): StripSecurity[] {
  return stripOrder(secs.filter((s) => s.bellwether));
}

export interface ResolvedSelection {
  /** The columns to render, in order. */
  columns: StripSecurity[];
  /** True when nothing was picked and these are the defaults. */
  isDefault: boolean;
  /** Symbols the URL named that are not in the watchlist. Reported, never silently dropped. */
  unknown: string[];
}

/**
 * Turn a parsed selection into actual columns.
 *
 * ORDER: pinned first in pin order, then everything else in the order it was picked (Bodhi,
 * 2026-09-20). This is the one place the strip's "no ordering carries a verdict" rule bends, and
 * it bends for a reason worth writing down: hard constraint 1 forbids THE PRODUCT asserting a
 * ranking — a strip sorted by RSI would be a recommendation with extra steps. An order the reader
 * dragged into place asserts nothing about the securities; it is a workspace, not a claim. The
 * default view, which the product does choose, stays theme-ordered.
 *
 * A pinned symbol that was never picked is still shown. A link with only `?pin=AVGO` is a
 * reasonable thing to send someone and should not render an empty strip.
 */
export function resolveSelection(
  secs: StripSecurity[],
  sel: Selection,
): ResolvedSelection {
  const by = new Map(secs.map((s) => [s.symbol.toUpperCase(), s]));
  const named = [...sel.pinned, ...sel.picked];
  const unknown = [...new Set(named.filter((s) => !by.has(s)))];

  if (named.length === 0) {
    return { columns: defaultColumns(secs), isDefault: true, unknown: [] };
  }

  const out: StripSecurity[] = [];
  const used = new Set<string>();
  for (const sym of named) {
    const hit = by.get(sym);
    if (!hit || used.has(sym)) continue;
    used.add(sym);
    out.push(hit);
  }
  // Every named symbol was unknown — a stale link, or a typo. Fall back to the default rather
  // than to an empty strip, and let the caller say what happened.
  if (out.length === 0) return { columns: defaultColumns(secs), isDefault: true, unknown };
  return { columns: out, isDefault: false, unknown };
}

/** Add a symbol to the end of the picked list, or do nothing if it is already there. */
export function pick(sel: Selection, symbol: string, all: StripSecurity[]): Selection {
  const s = symbol.toUpperCase();
  if (sel.picked.includes(s) || sel.pinned.includes(s)) return sel;
  // Adding to an empty selection materialises the default first, so the first click ADDS a name
  // rather than replacing nine with one - which is what "add" has to mean when the thing you are
  // adding to is on screen in front of you.
  const base = sel.picked.length === 0 && sel.pinned.length === 0
    ? defaultColumns(all).map((x) => x.symbol)
    : sel.picked;
  return { ...sel, picked: [...base, s].slice(0, MAX_PICKED) };
}

/** Remove a symbol entirely, from both lists. */
export function drop(sel: Selection, symbol: string, all: StripSecurity[]): Selection {
  const s = symbol.toUpperCase();
  const base = sel.picked.length === 0 && sel.pinned.length === 0
    ? defaultColumns(all).map((x) => x.symbol)
    : sel.picked;
  return {
    picked: base.filter((x) => x !== s),
    pinned: sel.pinned.filter((x) => x !== s),
  };
}

/** Pin a symbol to the left, or unpin it back into its place in the picked order. */
export function togglePin(sel: Selection, symbol: string, all: StripSecurity[]): Selection {
  const s = symbol.toUpperCase();
  const base = sel.picked.length === 0 && sel.pinned.length === 0
    ? defaultColumns(all).map((x) => x.symbol)
    : sel.picked;
  if (sel.pinned.includes(s)) {
    // Unpinning returns it to the picked list rather than removing it. Unpin is not a delete.
    return {
      picked: base.includes(s) ? base : [...base, s],
      pinned: sel.pinned.filter((x) => x !== s),
    };
  }
  return { picked: base.filter((x) => x !== s), pinned: [...sel.pinned, s] };
}
