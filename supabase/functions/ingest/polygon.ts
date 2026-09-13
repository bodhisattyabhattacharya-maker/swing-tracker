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
 * PLAN LIMITS on the free (Basic) plan, from the published pricing page:
 *   - 5 requests per minute. Hence minIntervalMs = 12500 (4.8/min, deliberately under).
 *   - 2 years of history. `full` therefore means 2 years, NOT all time - see the ATH note below.
 *   - Minute and day aggregates; 15-minute-delayed or EOD data, which is all an end-of-day
 *     tracker needs.
 *   Upgrading to Starter ($29) makes calls unlimited and history 5 years; only the two
 *   constants below change.
 *
 * BASIS: `adjusted=true` adjusts for SPLITS ONLY - "We support historical market data that is
 * adjusted for splits, but not dividends" (vendor knowledge base, 2026-09-13). That is the same
 * basis as Yahoo's `close` column, which is what the golden values in DEFINITIONS.md were
 * computed on, and it is TradingView's default chart basis. So `close` is comparable across the
 * provider switch and `adj_close` is left null rather than filled with a lie.
 *
 * ALL-TIME HIGH: two years of history cannot produce a true all-time high. For most of this
 * watchlist the high is recent and inside the window, but INTC, QCOM and GE peaked in 2000.
 * `% off ATH` is therefore bounded by what we store until a deep one-time backfill lands -
 * flagged in DEFINITIONS.md rather than quietly reported as an all-time figure.
 *
 * HOURLY: not implemented here yet, and deliberately. Polygon's hour aggregates align to clock
 * hours and include extended-hours trading; TradingView's 1H bars align to the 09:30 session
 * open and exclude it. Rolling minute aggregates into session-aligned hours is the correct fix
 * and lands in its own PR, because hourly RSI has a 30/70 threshold and bar alignment moves it.
 */

import { type BarProvider, type DailyBar, type HourlyBar, type Range, RateLimitError } from "./provider.ts";

export const POLYGON_SOURCE = "polygon-aggs";

const HOST = "https://api.polygon.io";

/** 5 req/min published, so 12.5 s between requests keeps us at 4.8/min with margin. */
const MIN_INTERVAL_MS = 12_500;

/** Free plan ceiling is 2 years; 720 days leaves room for the window being inclusive. */
const FULL_DAYS = 720;

/** Incremental covers a missed week of scheduled runs several times over. */
const INCREMENTAL_DAYS = 35;

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
      volume: a.v ?? null,
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

    const r = await fetch(aggsUrl(symbol, range), {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    });
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

  // Session-aligned hourly is a separate piece of work - see the HOURLY note in the header.
  hourly(): Promise<HourlyBar[] | null> {
    return Promise.resolve(null);
  },
};
