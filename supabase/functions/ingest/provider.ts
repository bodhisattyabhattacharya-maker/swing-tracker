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

/**
 * One SESSION-ALIGNED hourly bar. Matches `hourly_session_bars` (decision 0058), not the older
 * clock-aligned `hourly_bars`, which nothing writes or reads any more.
 *
 * `ts` is the bucket START in UTC, ISO 8601 - 13:30Z for the 09:30 EDT bar - and is the upsert key.
 * `d` is the ET trading date, stored so the grid can join an hour to its session without doing
 * timezone arithmetic in SQL. `minutes` is how many one-minute bars fed the bucket: 60, or 30 for
 * the last one of the day, and anything less means the vendor's minutes had a gap. `closes_session`
 * marks the bucket ending at that day's close (16:00, or 13:00 on a half day); the grid reads a day's
 * hourly value from that row only.
 */
export interface HourlyBar {
  symbol: string;
  ts: string;
  d: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
  minutes: number;
  closes_session: boolean;
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
// The daily numbers come from the edge function's 150 s wall clock, NOT from a rate limit - Stocks
// Starter publishes unlimited calls (2026-09-13). See the header of index.ts. The edge runtime ALSO
// caps each request at 2 s of CPU, and for hourly that is the tighter of the two (measured
// 2026-09-27, see HOURLY LIMITS below). Daily has not hit it, including the 17-symbol full backfill of
// 2026-09-17 - its payloads are ~1,250 day bars, not ~60,000 minutes, and there is no bucketing.
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
export function planLimit(
  forceFull: boolean,
  explicit: string | null,
  kind: "daily" | "hourly" = "daily",
): number {
  if (explicit !== null && explicit !== "") {
    const n = Number(explicit);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  if (kind === "hourly") return forceFull ? HOURLY_LIMIT_FULL : HOURLY_LIMIT_INCREMENTAL;
  return forceFull ? DEFAULT_LIMIT_FULL : DEFAULT_LIMIT_INCREMENTAL;
}

/**
 * HOURLY LIMITS. The binding constraint is CPU TIME, not the wall clock - measured, and it is not
 * what this comment said when it shipped.
 *
 * The first version reasoned from the 150 s wall clock and guessed 4 s a top-up, 10 s a full fetch.
 * The backfill of 2026-09-27 measured something else (ingest_runs 51-57, function logs):
 *   - a 90-day full fetch costs ~0.6 s of WALL time a symbol (six in 4.0 s, ten in 4.9 s, five in 4.5 s);
 *   - and ~0.12 s of CPU, against the edge runtime's 2 s CPU budget per request. `limit=47` was
 *     killed with "CPU Time exceeded" (HTTP 546, WORKER_RESOURCE_LIMIT) after 17 symbols, ten
 *     seconds in - nowhere near 150.
 *   - Three requests sent together (one SQL paste, so pg_net fires them at once) died after 7 and 8
 *     symbols while the third, of 10, finished. They appear to have SHARED one budget. Inferred from
 *     the timing, not documented - treat concurrent calls as one.
 * Where the CPU goes is not profiled; JSON-parsing ~60,000 minutes and bucketing them is the likely
 * bulk (bucketing alone measured 105 ms a symbol here, session.ts).
 *
 * So: HOURLY_LIMIT_FULL = 6 is ~0.7 s of CPU - right, for the CPU reason. The incremental fetch is 7
 * days, about a ninth of a full one, so 30 top-ups is an estimated ~0.4 s. That is still an ESTIMATE:
 * the first scheduled run (Monday 2026-09-28, triggered_by = 'cron-hourly') is the measurement. The
 * two shards stay: one job of 53 top-ups would be ~0.7 s and would probably fit, but nothing has
 * measured a top-up yet.
 *
 * `hourly_capacity` in ingest_test.ts pins shards x limit against the watchlist either way.
 */
export const HOURLY_LIMIT_INCREMENTAL = 30;
export const HOURLY_LIMIT_FULL = 6;

/**
 * How many AUTOMATIC full fetches one run may make - symbols planned "full" only because they have
 * no bars yet, on a run that did not ask for `full=1`.
 *
 * WHY HOURLY NEEDS THIS AND DAILY HAS LIVED WITHOUT IT. The night this ships, every equity has zero
 * hourly bars, so every one of them plans "full" - and the incremental limit of 30 would then admit
 * 30 full fetches, five times what HOURLY_LIMIT_FULL judges safe. It was written to protect the
 * wall clock; the backfill showed it protects the 2 s CPU budget, which 30 full fetches (~3.6 s)
 * would blow by half again. A run killed either way loses its whole error record. The same
 * hole exists on the daily path and is written up at DEFAULT_LIMIT_INCREMENTAL; it is not closed
 * here because nothing daily changed in this PR and its limits are measured, not guessed.
 *
 * With the cap, the first scheduled night backfills six symbols per shard and defers the rest,
 * visibly, and the manual backfill in the runbook does the job properly. A forced `full=1` run is
 * unaffected: every symbol is full there and `limit` already governs.
 */
export function autoFullCap(kind: "daily" | "hourly", forceFull: boolean): number {
  if (forceFull || kind === "daily") return Number.POSITIVE_INFINITY;
  return HOURLY_LIMIT_FULL;
}

/**
 * `?shard=k/n` - this run takes every n-th symbol starting at k, from the list as `activeSymbols`
 * returns it (ordered by symbol). Returns null for an absent parameter and throws on a malformed one,
 * because a typo that silently meant "all symbols" would double the work of a split schedule.
 *
 * WHY NOT `offset`, which already exists. `offset` is applied AFTER the plan is sorted with
 * never-fetched symbols first, which is right for walking a one-time deepening and wrong for two
 * jobs on a timer: job A backfills some names, they move from the front of the list to the back,
 * and job B's offset now points at a different list - the first night hourly shipped, it would have
 * skipped every symbol job A had not reached. A shard is chosen BEFORE planning, from a list both
 * jobs read identically, so each symbol belongs to exactly one job whatever state it is in.
 */
export function parseShard(v: string | null): { k: number; n: number } | null {
  if (v === null || v === "") return null;
  const m = /^(\d+)\/(\d+)$/.exec(v);
  if (!m) throw new Error(`bad shard "${v}" - expected k/n, e.g. 0/2`);
  const k = Number(m[1]);
  const n = Number(m[2]);
  if (n < 1 || k >= n) throw new Error(`bad shard "${v}" - need 0 <= k < n`);
  return { k, n };
}

/** Pure: the symbols a shard owns. Every symbol is in exactly one shard of any given n. */
export function inShard<T>(items: T[], shard: { k: number; n: number } | null): T[] {
  if (shard === null) return items;
  return items.filter((_, i) => i % shard.n === shard.k);
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

