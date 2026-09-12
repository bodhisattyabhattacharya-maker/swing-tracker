/**
 * watchlist.ts — read config/watchlist.yml from the public repo and shape it for `tickers`.
 *
 * Why fetch the yml at run time instead of reading `tickers`: the yml is the source of truth
 * and `tickers` is a cache (CODEMAP invariant 2; the table's own comment says so). Reading the
 * file each run is what makes "add a line, commit, the next run backfills it" true without a
 * deploy. The repo is public, so raw.githubusercontent.com needs no token.
 *
 * Removed symbols are DEACTIVATED, never deleted: `daily_bars` cascades on delete, so deleting
 * a ticker would erase years of history for a one-line edit. Re-adding it flips `active` back
 * and the bars are still there.
 *
 * Indices carry theme "index" and rankable=false. "index" is not a declared theme in the yml -
 * that block is for tradeable peer groups - and the CI check only validates ticker themes, so
 * this is consistent. `is_index` is what the grid filters on; `theme` is just non-null.
 */

import { parse } from "npm:yaml@2";

/** The row we upsert into `tickers`. `synced_at` is set by the caller so one run has one stamp. */
export interface TickerRow {
  symbol: string;
  name: string;
  theme: string;
  tag: string | null;
  bellwether: boolean;
  rankable: boolean;
  is_index: boolean;
  active: boolean;
  source: string;
}

interface WatchlistYaml {
  themes?: Record<string, { label?: string; rankable?: boolean; note?: string }>;
  tickers?: Array<{ symbol: string; name: string; theme: string; tag?: string; bellwether?: boolean }>;
  indices?: Array<{ symbol: string; name: string }>;
}

export const DEFAULT_WATCHLIST_URL =
  "https://raw.githubusercontent.com/bodhisattyabhattacharya-maker/swing-tracker/main/config/watchlist.yml";

/**
 * Pure: yml text -> rows. Throws on a symbol whose theme is not declared, because a silent
 * default here would let a typo in the yml become a wrong peer group in the ranks.
 */
export function parseWatchlist(text: string, source = "config/watchlist.yml"): TickerRow[] {
  const doc = parse(text) as WatchlistYaml;
  const themes = doc.themes ?? {};
  const rows: TickerRow[] = [];

  for (const t of doc.tickers ?? []) {
    const theme = themes[t.theme];
    if (!theme) throw new Error(`watchlist: ${t.symbol} has undeclared theme "${t.theme}"`);
    rows.push({
      symbol: t.symbol,
      name: t.name,
      theme: t.theme,
      tag: t.tag ?? null,
      bellwether: t.bellwether ?? false,
      // The theme decides rankability, not the ticker - a rank only means something across
      // the whole peer group (watchlist.yml header).
      rankable: theme.rankable ?? true,
      is_index: false,
      active: true,
      source,
    });
  }

  for (const i of doc.indices ?? []) {
    rows.push({
      symbol: i.symbol,
      name: i.name,
      theme: "index",
      tag: null,
      bellwether: false,
      rankable: false,
      is_index: true,
      active: true,
      source,
    });
  }

  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.symbol)) throw new Error(`watchlist: duplicate symbol ${r.symbol}`);
    seen.add(r.symbol);
  }
  return rows;
}

export async function fetchWatchlist(url = DEFAULT_WATCHLIST_URL): Promise<TickerRow[]> {
  const r = await fetch(url, { headers: { Accept: "text/plain" } });
  if (!r.ok) throw new Error(`watchlist: HTTP ${r.status} from ${url}`);
  return parseWatchlist(await r.text());
}
