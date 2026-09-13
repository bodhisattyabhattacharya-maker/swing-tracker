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
   * plan publishes 5 requests/minute, so the number below is derived from a documented figure
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
