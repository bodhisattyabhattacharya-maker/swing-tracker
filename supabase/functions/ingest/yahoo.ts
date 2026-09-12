/**
 * yahoo.ts — BarProvider backed by Yahoo's v8/finance/chart endpoint.
 *
 * Status:  unofficial and keyless. It works from Supabase's egress (CONSTRAINTS.md 2026-08-17)
 *          and breaks without notice. When it does: CONSTRAINTS.md entry with the date, then
 *          INCIDENTS.md, then fix. Do not "harden" this with retries that hide the breakage.
 * Ranges:  daily incremental = 1mo (covers a missed week of runs with margin),
 *          daily full        = max (first trade onward; MU 1984, INTC 1980),
 *          hourly incremental = 5d, hourly full = 2y (~3,500 bars; the cap Yahoo enforces).
 *          The 3-month-hourly note in older docs was wrong - see CONSTRAINTS.md 2026-09-05.
 * Shape:   a bad symbol returns HTTP 200 with `chart.error` set, and a thin symbol can return
 *          200 with no `timestamp` array. Both are treated as errors; the status code alone
 *          is not trusted.
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

const RANGES = {
  daily: { incremental: "1mo", full: "max" },
  hourly: { incremental: "5d", full: "2y" },
} as const;

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

async function fetchChart(symbol: string, range: string, interval: "1d" | "1h"): Promise<ChartResponse> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=${range}&interval=${interval}&includeAdjustedClose=true`;
  const r = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!r.ok) throw new Error(`${symbol}: HTTP ${r.status} for range=${range} interval=${interval}`);
  return await r.json() as ChartResponse;
}

export const yahoo: BarProvider = {
  name: YAHOO_SOURCE,

  async daily(symbol: string, range: Range): Promise<DailyBar[]> {
    const json = await fetchChart(symbol, RANGES.daily[range], "1d");
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
    const json = await fetchChart(symbol, RANGES.hourly[range], "1h");
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
