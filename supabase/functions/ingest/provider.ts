/**
 * provider.ts — the seam between "where bars come from" and "what we do with them".
 *
 * Why a seam at all: it let us replace the entire data source in one PR when Yahoo blocked
 * Supabase's egress IP (decision 0019, INCIDENTS.md 2026-09-13). `index.ts` never learned that
 * the provider changed; it asks for bars and writes what it gets. Every row carries `source`,
 * so bars from different providers coexist in one table and can always be told apart.
 *
 * Deliberately minimal. Do not add methods here until a second implementation actually needs
 * them (CODE_STYLE: "two call sites is not a framework").
 */

/** One trading day. Matches `daily_bars` column for column (20260912120000_foundation). */
export interface DailyBar {
  symbol: string;
  /** ISO date, YYYY-MM-DD, in the exchange's trading calendar. */
  d: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  /**
   * DIVIDEND-adjusted close, and only that. Null when the provider does not supply one, which
   * is the normal case now: Polygon adjusts for splits but not dividends, so `close` above is
   * already the split-adjusted series and there is nothing extra to record here.
   *
   * Never copy `close` into this column. A raw close masquerading as dividend-adjusted would
   * silently change the basis of any parameter that reads it. See DEFINITIONS.md §"basis".
   */
  adj_close: number | null;
  volume: number | null;
  source: string;
}

/** One hourly bar. Matches `hourly_bars`. `ts` is the bar OPEN time, UTC, ISO 8601. */
export interface HourlyBar {
  symbol: string;
  ts: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
  source: string;
}

/**
 * Range vocabularies are intentionally tiny. `incremental` is what the scheduled clocks ask
 * for; `full` is the one-time backfill (and the automatic catch-up for a symbol with no bars
 * yet). A provider maps these to its own API's parameters and its own plan's history limit.
 */
export type Range = "incremental" | "full";

export interface BarProvider {
  /** Written to `source` on every row. Keep it stable; it is how a provider swap is audited. */
  readonly name: string;

  /**
   * Minimum gap between requests, in milliseconds, that this provider's plan tolerates.
   *
   * This exists because pacing is a property of the PROVIDER, not of the ingest loop. Yahoo had
   * no published limit and punished us for guessing (INCIDENTS.md 2026-09-13); Polygon's free
   * plan publishes its limit, so the number below is derived from a documented figure
   * rather than a hunch. A provider that raises its limit changes this one line.
   */
  readonly minIntervalMs: number;

  /**
   * True if this provider can serve the symbol at all. `index.ts` uses it to route: FRED knows
   * the index series, Polygon knows the equities, and a symbol nobody claims is an error rather
   * than a silent gap.
   */
  supports(symbol: string): boolean;

  daily(symbol: string, range: Range): Promise<DailyBar[]>;

  /**
   * Hourly bars. A provider that cannot serve them returns null — distinct from returning an
   * empty array, which would mean "I serve hourly and there were no bars". FRED is closes-only,
   * so it returns null and the caller records the symbol as skipped rather than failed.
   */
  hourly(symbol: string, range: Range): Promise<HourlyBar[] | null>;
}

/** A rate-limit rejection. Distinct from a per-symbol failure: it means stop, not skip. */
export class RateLimitError extends Error {
  constructor(provider: string, symbol: string) {
    super(`${provider}/${symbol}: rate limited (HTTP 429) - aborting run`);
    this.name = "RateLimitError";
  }
}

// ---------------------------------------------------------------------------
// Per-run caps.
//
// These live here rather than in index.ts for two reasons. One: index.ts calls `Deno.serve` at
// module top level, so importing anything from it inside a test starts a real HTTP listener and
// leaks it. Two: this file already owns `minIntervalMs`, so "how fast may we go" and "how much may
// one run do" end up in the same place instead of two.
//
// The numbers come from the edge function's 150 s wall clock, NOT from a rate limit - Stocks
// Starter publishes unlimited calls (2026-09-13). See the header of index.ts.
// ---------------------------------------------------------------------------

/**
 * How many symbols one routine top-up run may fetch.
 *
 * 45 UNTIL 2026-09-18, AND IT WAS A SILENT CEILING. The comment it replaces said "the whole
 * watchlist fits one run, with room for growth". That was true of 36 tickers and became false the
 * night the universe went to 53 (plus three indices = 56). `activeSymbols` orders by symbol and the
 * plan sort is a stable partition, so the cap did not sample the watchlist - it cut a DETERMINISTIC
 * ALPHABETICAL TAIL, the same eleven names every night, which then fell one day further behind per
 * run and could never catch up. On 2026-09-18 that tail was SMCI, SNDK, STX, TSLA, TSM, TXN, UNH,
 * VRT, WDC, WMT, XOM, and the run that starved them finished ok = true.
 *
 * 90 IS FROM MEASUREMENT, not from taste. Two real runs, both inside a 150 s wall clock:
 *   2026-09-16  39 top-ups, 973 rows, 32.4 s   -> ~0.8 s per symbol
 *   2026-09-17  17 full backfills of ~1237 bars each plus 28 top-ups, 21,727 rows, 32.2 s
 * At 0.8 s a symbol, 90 top-ups is ~72 s and leaves half the budget unspent. 90 is also 1.6x the
 * current 56, so the watchlist can grow by half again before this number needs another look.
 *
 * THE WORST CASE THIS DOES NOT SOLVE, stated because the next person will meet it: a night when a
 * large batch of NEW tickers lands uses this limit while most of the batch needs a full backfill,
 * and 90 backfills would not fit. `DEFAULT_LIMIT_FULL` does not apply - it governs `full=1` runs
 * only. The honest fix there is to cap a run by estimated cost rather than by symbol count, which
 * is a bigger change than this one. Until then two detectors make the failure loud instead of
 * silent: `verify_parameters.sql` fails when a symbol goes from current yesterday to missing today,
 * and `grid_status.symbols_behind` puts the count on the dashboard.
 *
 * A test pins this against config/watchlist.yml, so growing the watchlist past the cap fails CI
 * rather than quietly dropping whatever sorts last.
 */
const DEFAULT_LIMIT_INCREMENTAL = 90;

/**
 * A full fetch is ~1250 bars per symbol at roughly 2-3 s each, so 15 is about 40 s. The margin
 * under 150 s is deliberately generous: a run killed by the wall clock loses every per-symbol
 * error it had collected, which is how the first live attempt became an unexplainable "504".
 */
const DEFAULT_LIMIT_FULL = 15;

/**
 * Pure: how many symbols this run may fetch. An explicit `?limit=` always wins; junk falls back to
 * the default rather than to zero, because a limit of zero fetches nothing and looks like success.
 *
 * Exported so a test pins the intent. The regression being guarded against is someone collapsing
 * the two defaults into one, which either throttles every routine refresh or gets a backfill
 * killed halfway.
 */
export function planLimit(forceFull: boolean, explicit: string | null): number {
  if (explicit !== null && explicit !== "") {
    const n = Number(explicit);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return forceFull ? DEFAULT_LIMIT_FULL : DEFAULT_LIMIT_INCREMENTAL;
}

// ---------------------------------------------------------------------------
// Scopes, and which slice of the watchlist each one touches.
//
// Lives here rather than in index.ts for the usual reason: index.ts calls `Deno.serve` at module
// top level, so a test that imported it would start a real listener. Routing is this file's job
// already - `supports()` decides which provider claims a symbol - and "which symbols does this run
// touch" is the same kind of decision one level up.
// ---------------------------------------------------------------------------

export type Scope = "tickers" | "daily" | "hourly" | "indices" | "all";

export const SCOPES: readonly Scope[] = ["tickers", "daily", "hourly", "indices", "all"] as const;

export function isScope(v: string): v is Scope {
  return (SCOPES as readonly string[]).includes(v);
}

export type Universe = "all" | "equities" | "indices";

/**
 * Which symbols a scope's BAR work covers, or null when it does no bar work.
 *
 * `daily` and `all` include the index series, because the market block and the relative-strength
 * base are indices and they are cheap - three FRED calls.
 *
 * `hourly` excludes them: hourly feeds RSI-hourly, which is not computed for indices, and FRED
 * publishes a daily close with no intraday series to ask for.
 *
 * `indices` is the odd one, added 2026-09-15. It exists because **FRED publishes later than the
 * 22:30 UTC run**: on 2026-09-14 that run fetched Friday's ^VIX, not Monday's, while every equity
 * came back same-evening. A second, index-only pass the next morning catches the previous close
 * without re-fetching 36 equities that are already current. It is NOT part of `all` - `all` already
 * covers indices through `daily`, and having two names for the same work is how a run gets done
 * twice.
 */
export function universeFor(scope: Scope): Universe | null {
  switch (scope) {
    case "daily":
    case "all":
      return "all";
    case "hourly":
      return "equities";
    case "indices":
      return "indices";
    case "tickers":
      return null;
  }
}

