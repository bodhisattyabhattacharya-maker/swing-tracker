/**
 * provider.ts — the seam between "where bars come from" and "what we do with them".
 *
 * Why a seam at all: decision 0003 says no paid feed for v1, but the proposal promises that
 * one can slot in later without touching the ingest logic. This interface is the whole of
 * that promise. A paid provider implements `BarProvider`, `index.ts` picks it by name, and
 * every row it writes carries `source` so the two can coexist in one table and be told apart.
 *
 * Deliberately minimal: two methods, two range vocabularies. Do not add methods here until a
 * second implementation actually needs them (CODE_STYLE: "two call sites is not a framework").
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
  /** Split- and dividend-adjusted close. Null when the provider does not supply one —
   *  never silently copied from `close`, because "% off all-time high" reads this column
   *  and a raw close masquerading as adjusted would put the ATH on the wrong basis. */
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
 * yet). A provider maps these to its own API's parameters.
 */
export type Range = "incremental" | "full";

export interface BarProvider {
  /** Written to `source` on every row. Keep it stable; it is how a provider swap is audited. */
  readonly name: string;
  daily(symbol: string, range: Range): Promise<DailyBar[]>;
  hourly(symbol: string, range: Range): Promise<HourlyBar[]>;
}
