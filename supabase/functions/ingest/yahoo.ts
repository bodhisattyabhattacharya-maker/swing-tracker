/**
 * yahoo.ts — BarProvider backed by Yahoo's v8/finance/chart endpoint.
 *
 * Status:  unofficial and keyless. It works from Supabase's egress (CONSTRAINTS.md 2026-08-17)
 *          and breaks without notice. When it does: CONSTRAINTS.md entry with the date, then
 *          INCIDENTS.md, then fix. Do not "harden" this with retries that hide the breakage.
 * Ranges:  daily incremental  = range=1mo (covers a missed week of runs with margin),
 *          daily full         = period1/period2 epochs, NOT range=max. `range=max&interval=1d`
 *                               silently returns QUARTERLY or MONTHLY bars - Yahoo picks a
 *                               granularity from the span and ignores `interval`. Measured:
 *                               ^GSPC 169 bars 90.8 days apart, ^VIX 441 bars 30.4 days apart
 *                               (INCIDENTS.md 2026-09-13). Explicit epochs return true daily.
 *          hourly incremental = range=5d, hourly full = range=2y. Verified live: 3,484 bars,
 *                               2024-09-12 to 2026-09-11, exactly the 2-year cap.
 * Shape:   a bad symbol returns HTTP 200 with `chart.error` set, and a thin symbol can return
 *          200 with no `timestamp` array. Both are treated as errors; the status code alone
 *          is not trusted.
 * Rate:    Yahoo rate-limits by source IP and the penalty OUTLASTS the burst. ~90 requests in
 *          7 seconds from Supabase's egress earned a plain-text `429 Too Many Requests` that was
 *          still in force 6 minutes later, for a single request. A 429 therefore raises
 *          RateLimitError, which the caller treats as "stop the whole run", not "skip this
 *          symbol" - continuing would only deepen the penalty.
 * Nulls:   Yahoo pads missing OHLC with null inside the arrays. A bar with a null close is
 *          dropped (nothing downstream can use it); null open/high/low/volume are kept as null.
 *          `adj_close` is null when the adjclose array is absent - NOT copied from close.
 *
 * `mapChart` is exported on its own, pure, so it can be unit-tested against a saved response
 * without network (this sandbox has none to Yahoo - CLAUDE.md constraint 1).
 */

import type { BarProvider, DailyBar, HourlyBar, Range } from "./provider.ts";

export const YAHOO_SOURCE = "yahoo-chart";

/** Yahoo serves a bot-check page to bare clients. A browser UA is enough; no cookie or crumb
 *  is needed for `chart` (unlike `quoteSummary`, which is why we have no analyst targets). */
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** A 429 from Yahoo. Distinct from a per-symbol failure: it means stop, not skip. */
export class RateLimitError extends Error {
  constructor(symbol: string) {
    super(`${symbol}: HTTP 429 from Yahoo - rate limited, aborting run`);
    this.name = "RateLimitError";
  }
}

/**
 * Build the chart URL. Pure and exported so the range-vs-epoch choice is unit-tested - getting
 * it wrong does not fail loudly, it quietly returns the wrong granularity (INCIDENTS.md).
 *
 * `now` is injectable only so a test can assert a fixed URL; production always passes the clock.
 */
export function chartUrl(
  symbol: string,
  kind: "daily" | "hourly",
  range: Range,
  now: Date = new Date(),
): string {
  const base = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
  const common = "includeAdjustedClose=true";

  if (kind === "daily" && range === "full") {
    // period1=0 is 1970; Yahoo clamps to the symbol's first trade. period2 is tomorrow, so the
    // current session is always inside the window. Epochs, not range=max - see the header.
    const period2 = Math.floor(now.getTime() / 1000) + 86400;
    return `${base}?period1=0&period2=${period2}&interval=1d&${common}`;
  }

  // Everything else is a `range`. Daily full never reaches here - it returned above, and it
  // must stay that way: `range=max&interval=1d` is the downsampling trap.
  if (kind === "daily") return `${base}?range=1mo&interval=1d&${common}`;
  return `${base}?range=${range === "incremental" ? "5d" : "2y"}&interval=1h&${common}`;
}

/** The subset of Yahoo's response we read. Everything else is ignored on purpose. */
export interface ChartResponse {
  chart?: {
    /** Null (not absent) when Yahoo sets `error` - a bad or delisted symbol. */
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: (number | null)[];
          high?: (number | null)[];
          low?: (number | null)[];
          close?: (number | null)[];
          volume?: (number | null)[];
        }>;
        adjclose?: Array<{ adjclose?: (number | null)[] }>;
      };
    }> | null;
    error?: { code?: string; description?: string } | null;
  };
}

/** A parsed bar before it is shaped for one of the two tables. */
interface RawBar {
  /** Epoch seconds, bar open, UTC. */
  t: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  adj_close: number | null;
  volume: number | null;
}

/**
 * Pure: Yahoo JSON -> bars. Throws on the two "200 but broken" shapes so the caller records
 * an error for that symbol instead of writing nothing and reporting success.
 */
export function mapChart(json: ChartResponse, symbol: string): RawBar[] {
  const err = json.chart?.error;
  if (err) throw new Error(`${symbol}: ${err.description ?? err.code ?? "chart.error"}`);

  const res = json.chart?.result?.[0];
  const ts = res?.timestamp;
  if (!res || !Array.isArray(ts)) throw new Error(`${symbol}: no timestamp array in response`);

  const q = res.indicators?.quote?.[0] ?? {};
  const adj = res.indicators?.adjclose?.[0]?.adjclose;

  const out: RawBar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const close = q.close?.[i];
    if (close == null) continue; // padding row, not a bar
    out.push({
      t: ts[i],
      open: q.open?.[i] ?? null,
      high: q.high?.[i] ?? null,
      low: q.low?.[i] ?? null,
      close,
      // Absent array => null. Copying `close` here would silently put the ATH on the
      // unadjusted basis for that symbol (DEFINITIONS.md, "% off all-time high").
      adj_close: adj ? (adj[i] ?? null) : null,
      volume: q.volume?.[i] ?? null,
    });
  }
  return out;
}

/**
 * Daily timestamps from Yahoo are the session open in exchange-local time expressed as UTC
 * (09:30 New York = 13:30Z or 14:30Z). Taking the UTC calendar date is therefore the trading
 * date for every US listing. This would be wrong for an exchange whose session opens before
 * 00:00Z of the same calendar day - none on the watchlist do. Revisit if one is added.
 */
export function toTradingDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

async function fetchChart(symbol: string, kind: "daily" | "hourly", range: Range): Promise<ChartResponse> {
  const url = chartUrl(symbol, kind, range);
  const r = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  // 429 arrives as plain text, not JSON, so it must be caught before parsing.
  if (r.status === 429) throw new RateLimitError(symbol);
  if (!r.ok) throw new Error(`${symbol}: HTTP ${r.status} for ${kind} ${range}`);
  return await r.json() as ChartResponse;
}

export const yahoo: BarProvider = {
  name: YAHOO_SOURCE,

  async daily(symbol: string, range: Range): Promise<DailyBar[]> {
    const json = await fetchChart(symbol, "daily", range);
    const bars = mapChart(json, symbol);
    // Yahoo can emit two rows for the same date (a partial live candle after the closed one)
    // at the tail of the array. Last one wins, which is the live one during the session and
    // the settled one after the close - both correct for that moment. The next run overwrites.
    const byDate = new Map<string, DailyBar>();
    for (const b of bars) {
      byDate.set(toTradingDate(b.t), {
        symbol,
        d: toTradingDate(b.t),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        adj_close: b.adj_close,
        volume: b.volume,
        source: YAHOO_SOURCE,
      });
    }
    return [...byDate.values()];
  },

  async hourly(symbol: string, range: Range): Promise<HourlyBar[]> {
    const json = await fetchChart(symbol, "hourly", range);
    return mapChart(json, symbol).map((b) => ({
      symbol,
      ts: new Date(b.t * 1000).toISOString(),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
      source: YAHOO_SOURCE,
    }));
  },
};
