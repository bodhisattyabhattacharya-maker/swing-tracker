/**
 * polygon.ts — BarProvider over Polygon's aggregates endpoint.
 *
 * The vendor rebranded from polygon.io to massive.com in 2026 (polygon.io 302s there). The API
 * host is still api.polygon.io and the key still works, so the code keeps the working name; the
 * rebrand is recorded in CONSTRAINTS.md so nobody wastes time wondering which company this is.
 *
 * Why this provider (decision 0019): Yahoo blocked Supabase's egress IP indefinitely. A keyed
 * API cannot do that to us - the key identifies us, not the IP - and the free plan's limits are
 * published rather than guessed at.
 *
 * PLAN LIMITS on the Stocks Starter plan ($29/month, subscribed 2026-09-13):
 *   - **Unlimited** API calls. Pacing is now a courtesy, not a constraint - see MIN_INTERVAL_MS.
 *   - **5 years** of history. `full` therefore means ~5 years, still NOT all time - see the ATH
 *     note below, which the upgrade shortens but does not remove.
 *   - Minute and day aggregates, 15-minute delayed, which is irrelevant to an end-of-day tracker.
 *   - Flat files / S3 bulk access included. NOT used yet: at 36 symbols the per-symbol request
 *     loop is fine. It becomes the right answer at ~200 symbols, where the loop is what breaks.
 *
 * We were on the free (Basic) plan until 2026-09-13: 5 requests/minute and 2 years of history.
 * The old header predicted that upgrading would change "only the two constants below". It did -
 * exactly two constants and two tests. Worth noting because that prediction was the whole point
 * of putting the plan's limits in named constants instead of inline numbers.
 *
 * BASIS: `adjusted=true` adjusts for SPLITS ONLY - "We support historical market data that is
 * adjusted for splits, but not dividends" (vendor knowledge base, 2026-09-13). That is the same
 * basis as Yahoo's `close` column, which is what the golden values in DEFINITIONS.md were
 * computed on, and it is TradingView's default chart basis. So `close` is comparable across the
 * provider switch and `adj_close` is left null rather than filled with a lie.
 *
 * ALL-TIME HIGH: five years of history still cannot produce a true all-time high. INTC, QCOM and
 * GE peaked in 2000, outside every tier we would plausibly buy. `% off ATH` remains bounded by
 * what we store, the column is still named `pct_off_high_stored`, and DEFINITIONS.md still says
 * so. The upgrade moved the bound from 2 years to 5; it did not remove it, and the naming must
 * not drift into implying otherwise.
 *
 * VOLUME is a FLOAT in Polygon's response - MU came back with `v: 25426639.075335`, which is
 * fractional share volume aggregated up. `daily_bars.volume` is `bigint`, so it must be rounded
 * before the upsert or PostgreSQL rejects the whole batch ("invalid input syntax for type
 * bigint"). Rounding is the right call rather than widening the column: volume is a share count,
 * the only parameter that reads it is a ratio against a 50-bar average, and a fraction of one
 * share cannot move it. Verified live 2026-09-13 - INCIDENTS.md.
 *
 * HOURLY (implemented 2026-09-27, decision 0058). Polygon's hour aggregates align to clock hours
 * and include extended-hours trading; TradingView's 1H bars align to the 09:30 session open and
 * exclude it. So `hourly()` fetches ONE-MINUTE aggregates and hands them to session.ts, which
 * buckets them into the seven session hours itself. The alignment is therefore a property of our
 * code rather than an assumption about the vendor's, and session.ts is where it is tested.
 *
 * PAGINATION is new here. A daily window is a few hundred rows; a 90-day minute window with
 * extended hours is up to ~57,600, past the 50,000-row page. Polygon signals more with `next_url`.
 * The daily path never needed to follow it and does not; the hourly path must, or the OLDEST
 * 50,000 minutes would arrive and the newest week silently would not - with `sort=asc`, the
 * truncation lands on exactly the bars that matter.
 */

import { type BarProvider, type DailyBar, type HourlyBar, type Range, RateLimitError } from "./provider.ts";
import { fetchWithRetry } from "./http.ts";
import { type MinuteAgg, sessionHours } from "./session.ts";

export const POLYGON_SOURCE = "polygon-aggs";

const HOST = "https://api.polygon.io";

/**
 * Starter publishes "unlimited" API calls, so this is no longer a rate limit - it is deliberate
 * politeness. 200 ms is 5 requests/second, which keeps a 36-symbol sweep at 7 s and even a
 * 200-symbol sweep at 40 s, both inside the edge function's 150 s wall clock.
 *
 * NOT zero, and not to be "optimised" to zero. "Unlimited" is a billing statement, not a promise
 * about burst behaviour, and finding out empirically is precisely how the Yahoo pipeline died:
 * 90 requests in 6.9 seconds earned an IP block that was still in force 4.5 hours later
 * (INCIDENTS.md 2026-09-13, decision 0019). There is nothing to gain from going faster than this
 * and a whole provider to lose.
 */
const MIN_INTERVAL_MS = 200;

/**
 * Starter ceiling is 5 years (1826 days). 1800 leaves 26 days of margin, because asking for more
 * than the plan allows may be rejected - or worse, silently truncated, which would look like a
 * short history rather than a rejected request. Verify the depth from the earliest stored bar,
 * never from the billing page.
 */
const FULL_DAYS = 1800;

/** Incremental covers a missed week of scheduled runs several times over. */
const INCREMENTAL_DAYS = 35;

/**
 * HOURLY WINDOWS, in calendar days of MINUTES.
 *
 * Full: 90 days is ~60 sessions, ~420 session hours. RSI(14)'s seed floor is 125 bars
 * (DEFINITIONS.md §4), so the newest ~295 hours carry a settled RSI - comfortably more than the
 * three months TradingView users mean by "hourly RSI". At ~960 minutes a day with extended hours,
 * that is ~57,600 rows: two pages. See PAGINATION in the header.
 *
 * Incremental: 7 days covers a long weekend plus one missed night, in one page. Deliberately
 * shorter than the daily 35 - a daily top-up is ~25 rows, an hourly one is ~4,800, and payload is
 * what this job pays in wall clock.
 */
const HOURLY_FULL_DAYS = 90;
const HOURLY_INCREMENTAL_DAYS = 7;

/**
 * A page cap, so a vendor that kept handing back `next_url` could not hold the function until the
 * wall clock killed it and took the run's bookkeeping with it. Six pages is 300,000 minutes, five
 * times the largest window this file asks for; reaching it means something is wrong, and it throws.
 */
const MAX_PAGES = 6;

/**
 * The per-request timeout, the retry policy and the wall clock one symbol may spend all live in
 * http.ts now, so a transient 502 costs a pause rather than the night's bar. This file kept its own
 * 20 s constant until 2026-09-16; the reasoning moved with it and has not changed.
 *
 * NOTE for anyone adding a status check below: http.ts retries 5xx and transport failures ONLY. It
 * hands back every 4xx untouched, 429 included, so the three cases below behave exactly as they did.
 */

/** The fields we read from an aggregate bar. Everything else in the response is ignored. */
interface Agg {
  /** Unix MILLISECONDS at the start of the aggregate window. */
  t: number;
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  v?: number;
}

export interface AggsResponse {
  ticker?: string;
  adjusted?: boolean;
  resultsCount?: number;
  results?: Agg[] | null;
  status?: string;
  /** Present when the request was rejected or the plan does not cover it. */
  error?: string;
  message?: string;
  /** Present when there are more results than fit one page. Absolute URL, same auth. */
  next_url?: string;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Pure: build the aggregates URL. Exported so the date window and the `adjusted` flag are
 * pinned by tests - getting either wrong is silent, not loud (INCIDENTS.md 2026-09-13, where a
 * wrong range parameter returned quarterly bars that looked like daily ones).
 *
 * The key is passed as a header by the caller, never in the URL, so it cannot end up in a log.
 */
export function aggsUrl(symbol: string, range: Range, now: Date = new Date()): string {
  const days = range === "full" ? FULL_DAYS : INCREMENTAL_DAYS;
  const from = ymd(new Date(now.getTime() - days * 86_400_000));
  // `to` is tomorrow so today's bar is inside the window whenever it exists.
  const to = ymd(new Date(now.getTime() + 86_400_000));
  return `${HOST}/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${from}/${to}` +
    `?adjusted=true&sort=asc&limit=50000`;
}

/**
 * Pure: the one-minute aggregates URL for the hourly path. Exported and pinned for the same reason
 * `aggsUrl` is: a wrong window or a wrong timespan returns plausible data, not an error.
 */
export function minuteAggsUrl(symbol: string, range: Range, now: Date = new Date()): string {
  const days = range === "full" ? HOURLY_FULL_DAYS : HOURLY_INCREMENTAL_DAYS;
  const from = ymd(new Date(now.getTime() - days * 86_400_000));
  const to = ymd(new Date(now.getTime() + 86_400_000));
  return `${HOST}/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/minute/${from}/${to}` +
    `?adjusted=true&sort=asc&limit=50000`;
}

/**
 * Pure: response -> one-minute aggregates. Same validation as `mapAggs`, and it throws for the
 * same reasons: a response that cannot be trusted must cost the symbol, not write nothing and
 * report success.
 */
export function mapMinutes(json: AggsResponse, symbol: string): MinuteAgg[] {
  if (json.error || json.message) throw new Error(`${symbol}: ${json.error ?? json.message}`);
  if (json.status && !["OK", "DELAYED"].includes(json.status)) {
    throw new Error(`${symbol}: minute aggregates status ${json.status}`);
  }
  if (json.results == null) return [];
  if (!Array.isArray(json.results)) throw new Error(`${symbol}: results is not an array`);
  return json.results.filter((a) => typeof a.t === "number" && a.c != null);
}

/**
 * Pure: session hours -> rows for `hourly_session_bars`. Split from the fetch so the row shape is
 * testable - in particular that `ts` is the bucket START in UTC, which is the upsert key.
 */
export function toHourlyRows(symbol: string, minutes: MinuteAgg[], nowMs: number): HourlyBar[] {
  return sessionHours(minutes, nowMs).map((h) => ({
    symbol,
    ts: new Date(h.startMs).toISOString(),
    d: h.d,
    open: h.open,
    high: h.high,
    low: h.low,
    close: h.close,
    volume: h.volume,
    minutes: h.minutes,
    closes_session: h.closesSession,
    source: POLYGON_SOURCE,
  }));
}

/**
 * Polygon's daily aggregate timestamp is midnight in US/Eastern expressed as epoch ms, which is
 * 04:00Z or 05:00Z on the SAME calendar day depending on daylight saving. Taking the UTC date is
 * therefore the trading date, year round. Verified against both DST offsets in the tests.
 */
export function aggTradingDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * Pure: response -> bars. Throws when the response is not usable, so the caller records a
 * per-symbol error instead of writing nothing and reporting success.
 *
 * `results: null` with status OK is how Polygon says "no bars in this window" for a valid
 * ticker, which is not an error - an empty array is the honest answer.
 */
export function mapAggs(json: AggsResponse, symbol: string): DailyBar[] {
  if (json.error || json.message) {
    throw new Error(`${symbol}: ${json.error ?? json.message}`);
  }
  // A plan restriction or a bad ticker arrives as a non-OK status rather than an HTTP error.
  if (json.status && !["OK", "DELAYED"].includes(json.status)) {
    throw new Error(`${symbol}: aggregates status ${json.status}`);
  }
  const results = json.results;
  if (results == null) return [];
  if (!Array.isArray(results)) throw new Error(`${symbol}: results is not an array`);

  const out: DailyBar[] = [];
  for (const a of results) {
    // A bar with no close is unusable downstream; every parameter is built on close.
    if (a.c == null || typeof a.t !== "number") continue;
    out.push({
      symbol,
      d: aggTradingDate(a.t),
      open: a.o ?? null,
      high: a.h ?? null,
      low: a.l ?? null,
      close: a.c,
      // Split-adjusted only - see the BASIS note in the file header. Not a missing value.
      adj_close: null,
      // Rounded, not truncated, and never left as a float - see the VOLUME note in the header.
      volume: a.v == null ? null : Math.round(a.v),
      source: POLYGON_SOURCE,
    });
  }
  return out;
}

/**
 * Index symbols start with "^" in config/watchlist.yml. Polygon sells indices as a separate
 * asset-class subscription, so this provider declines them and FRED picks them up. Declining
 * loudly here is what stops an index silently ending up with equity-shaped nulls.
 */
function isIndexSymbol(symbol: string): boolean {
  return symbol.startsWith("^");
}

export const polygon: BarProvider = {
  name: POLYGON_SOURCE,
  minIntervalMs: MIN_INTERVAL_MS,

  supports(symbol: string): boolean {
    return !isIndexSymbol(symbol);
  },

  async daily(symbol: string, range: Range): Promise<DailyBar[]> {
    const key = Deno.env.get("POLYGON_API_KEY");
    if (!key) throw new Error("POLYGON_API_KEY is not set on the function");

    const r = await fetchWithRetry(aggsUrl(symbol, range), {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    }, { label: `${POLYGON_SOURCE}/${symbol}` });
    if (r.status === 429) throw new RateLimitError(POLYGON_SOURCE, symbol);
    if (r.status === 401 || r.status === 403) {
      throw new Error(`${symbol}: HTTP ${r.status} - key rejected or plan does not cover this`);
    }
    if (!r.ok) throw new Error(`${symbol}: HTTP ${r.status} from aggregates`);

    const bars = mapAggs(await r.json() as AggsResponse, symbol);

    // Last write wins per date. Polygon should not repeat a date, but the upsert key is
    // (symbol, d) and a duplicate in one payload would make PostgREST reject the whole batch.
    const byDate = new Map<string, DailyBar>();
    for (const b of bars) byDate.set(b.d, b);
    return [...byDate.values()];
  },

  // Minutes in, session hours out - see HOURLY and PAGINATION in the header.
  async hourly(symbol: string, range: Range): Promise<HourlyBar[]> {
    const key = Deno.env.get("POLYGON_API_KEY");
    if (!key) throw new Error("POLYGON_API_KEY is not set on the function");
    const headers = { Authorization: `Bearer ${key}`, Accept: "application/json" };

    const minutes: MinuteAgg[] = [];
    let url: string | undefined = minuteAggsUrl(symbol, range);
    for (let page = 0; url; page++) {
      if (page >= MAX_PAGES) {
        throw new Error(`${symbol}: more than ${MAX_PAGES} pages of minutes - refusing to guess where they end`);
      }
      const r = await fetchWithRetry(url, { headers }, { label: `${POLYGON_SOURCE}/${symbol}/minute` });
      if (r.status === 429) throw new RateLimitError(POLYGON_SOURCE, symbol);
      if (r.status === 401 || r.status === 403) {
        throw new Error(`${symbol}: HTTP ${r.status} - key rejected or plan does not cover minute aggregates`);
      }
      if (!r.ok) throw new Error(`${symbol}: HTTP ${r.status} from minute aggregates`);
      const json = await r.json() as AggsResponse;
      minutes.push(...mapMinutes(json, symbol));
      // Only follow a next_url on the vendor's own host. The key goes in a header on this request,
      // and a response that pointed elsewhere would carry it there.
      url = json.next_url && json.next_url.startsWith(HOST) ? json.next_url : undefined;
      if (url) await new Promise((res) => setTimeout(res, MIN_INTERVAL_MS));
    }
    return toHourlyRows(symbol, minutes, Date.now());
  },
};

// ---------------------------------------------------------------------------
// REFERENCE DATA for the fundamentals layer (Stage F2, decision 0060): stock splits and the ticker
// overview's share counts. Same host, same key, same courtesy pacing as the bars.
//
// UNVERIFIED ON THIS PLAN when written (2026-09-29): both are reference endpoints, which the vendor
// lists for every stocks tier, but no request has been made from here. The first fundamentals run
// answers it: a 403 lands in `massive_errors` for every company and the SEC half still completes.
// ---------------------------------------------------------------------------

export const MASSIVE_REFERENCE_SOURCE = "polygon-reference";

export function splitsUrl(symbol: string): string {
  return `${HOST}/v3/reference/splits?ticker=${encodeURIComponent(symbol)}&limit=1000&order=asc&sort=execution_date`;
}

export function tickerOverviewUrl(symbol: string): string {
  return `${HOST}/v3/reference/tickers/${encodeURIComponent(symbol)}`;
}

/** Matches `splits` column for column (ingested_at is the database's). */
export interface SplitRow {
  symbol: string;
  execution_date: string;
  split_from: number;
  split_to: number;
  source: string;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Pure: the splits response -> rows. A row for another ticker, a bad date, a non-positive side or a
 * 1-for-1 is dropped and counted, never guessed at: a wrong split ratio would silently multiply
 * every historical EPS by it. Two DIFFERENT ratios on one date throw - there is no right one to pick.
 */
export function mapSplits(json: unknown, symbol: string): { rows: SplitRow[]; dropped: number } {
  const results = (json as { results?: unknown })?.results;
  if (!Array.isArray(results)) throw new Error(`${symbol}: splits response has no results array`);
  const byDate = new Map<string, SplitRow>();
  let dropped = 0;
  for (const r of results as Record<string, unknown>[]) {
    const d = r?.execution_date, from = r?.split_from, to = r?.split_to;
    if (
      r?.ticker !== symbol || typeof d !== "string" || !YMD.test(d) ||
      typeof from !== "number" || typeof to !== "number" || !(from > 0) || !(to > 0) || from === to
    ) {
      dropped++;
      continue;
    }
    const prior = byDate.get(d);
    if (prior && (prior.split_from !== from || prior.split_to !== to)) {
      throw new Error(`${symbol}: two different splits on ${d} (${prior.split_from}:${prior.split_to} and ${from}:${to})`);
    }
    byDate.set(d, { symbol, execution_date: d, split_from: from, split_to: to, source: MASSIVE_REFERENCE_SOURCE });
  }
  return { rows: [...byDate.values()], dropped };
}

/** Matches `share_counts` column for column. */
export interface ShareCountRow {
  symbol: string;
  as_of: string;
  weighted_shares: number;
  class_shares: number | null;
  source: string;
}

/**
 * Pure: the ticker overview -> one share-count row as of `asOf`, or null when the overview carries
 * no weighted count (the caller then leaves the SEC cover page in charge). A missing `results`
 * object throws: that is a different endpoint's answer, not a company without a count.
 */
export function mapOverview(json: unknown, symbol: string, asOf: string): ShareCountRow | null {
  const r = (json as { results?: Record<string, unknown> })?.results;
  if (!r || typeof r !== "object") throw new Error(`${symbol}: ticker overview has no results object`);
  if (r.ticker !== symbol) throw new Error(`${symbol}: ticker overview answered for ${String(r.ticker)}`);
  const w = r.weighted_shares_outstanding;
  if (typeof w !== "number" || !(w > 0)) return null;
  const c = r.share_class_shares_outstanding;
  return {
    symbol,
    as_of: asOf,
    weighted_shares: w,
    class_shares: typeof c === "number" && c > 0 ? c : null,
    source: MASSIVE_REFERENCE_SOURCE,
  };
}

/** GET a reference document. Same status handling as the bars; never follows a foreign next_url. */
export async function referenceJson(url: string, label: string): Promise<unknown> {
  const key = Deno.env.get("POLYGON_API_KEY");
  if (!key) throw new Error("POLYGON_API_KEY is not set on the function");
  const r = await fetchWithRetry(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  }, { label: `${MASSIVE_REFERENCE_SOURCE}/${label}` });
  if (r.status === 429) throw new RateLimitError(MASSIVE_REFERENCE_SOURCE, label);
  if (r.status === 401 || r.status === 403) {
    throw new Error(`${label}: HTTP ${r.status} - key rejected or plan does not cover reference data`);
  }
  if (!r.ok) throw new Error(`${label}: HTTP ${r.status} from reference data`);
  return await r.json();
}

export { MIN_INTERVAL_MS as POLYGON_MIN_INTERVAL_MS };
