/**
 * fred.ts — BarProvider for the index series, backed by FRED (Federal Reserve Bank of St. Louis).
 *
 * Why FRED for indices (decision 0019): index data is the one thing every cheap equity API
 * either omits or sells as a separate subscription, and VIX is load-bearing for this tracker -
 * the whole "take profits when the market is peaking" idea rests on it. FRED publishes VIX and
 * the 3-month VIX as official CBOE series, free, with a documented API and no IP games. Verified
 * 2026-09-13: VXVCLS was current to 2026-09-10 at 19.73, so the term structure is live, not a
 * stale archive.
 *
 * WHAT THIS PROVIDER CANNOT DO, by design:
 *   - No OHLC. FRED publishes one observation per day, a CLOSE. open/high/low/volume are null.
 *     That is fine for every parameter that reads these symbols: VIX level, the VIX regime band
 *     and the term structure all use closes, and relative strength is a close-to-close return.
 *     It would NOT be fine for an intraday extreme, which is why constraint 6 ("extremes use
 *     intraday highs") applies to equities only - indices have no high/low here to misuse.
 *   - No hourly. Returns null, which the caller records as "skipped", not "failed".
 *
 * HISTORY: SP500 carries roughly 10 years for licensing reasons; VIXCLS goes back to 1990 and
 * VXVCLS to 2007. Ten years is ample - the deepest window any parameter asks for is 252 bars.
 *
 * RATE: FRED's documented limit is 120 requests/minute, far above anything we do (three series,
 * once a day). minIntervalMs is set to a courteous 1 s rather than the limit, because there is
 * no reason to go faster and the whole point of this rewrite was to stop being a rude guest.
 */

import { type BarProvider, type DailyBar, type HourlyBar, type Range, RateLimitError } from "./provider.ts";

export const FRED_SOURCE = "fred";

const HOST = "https://api.stlouisfed.org";
const MIN_INTERVAL_MS = 1_000;

/**
 * Watchlist symbol -> FRED series id.
 *
 * The keys are the "^"-prefixed symbols from config/watchlist.yml, so the watchlist stays the
 * single place a human edits (CODEMAP invariant 2). Adding an index means adding a line here
 * AND a line in the yml; a symbol in the yml with no entry here is an error, not a silent gap.
 */
export const SERIES: Record<string, string> = {
  "^VIX": "VIXCLS", // CBOE Volatility Index, daily close, 1990-
  "^VIX3M": "VXVCLS", // CBOE S&P 500 3-Month Volatility Index, 2007-
  "^GSPC": "SP500", // S&P 500 index level, ~10 year window
};

/** FRED's observation shape. `value` is a STRING, and "." means no observation that day. */
interface Observation {
  date?: string;
  value?: string;
}

export interface ObservationsResponse {
  observations?: Observation[] | null;
  error_code?: number;
  error_message?: string;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Pure: build the observations URL. The api_key is added by the caller so it never appears in a
 * value a test might print. `observation_start` is what makes `incremental` cheap.
 */
export function observationsUrl(seriesId: string, range: Range, now: Date = new Date()): string {
  // 4000 days ~ 11 years, comfortably past SP500's licensed window and enough for 252 bars.
  const days = range === "full" ? 4000 : 35;
  const start = ymd(new Date(now.getTime() - days * 86_400_000));
  return `${HOST}/fred/series/observations` +
    `?series_id=${encodeURIComponent(seriesId)}&file_type=json&observation_start=${start}`;
}

/**
 * Pure: observations -> daily bars with close only.
 *
 * Rows whose value is "." are DROPPED, not zeroed or carried forward. A market holiday has no
 * VIX close, and inventing one would put a fake observation into a series that rules read.
 */
export function mapObservations(
  json: ObservationsResponse,
  symbol: string,
  seriesId: string,
): DailyBar[] {
  if (json.error_message) throw new Error(`${symbol} (${seriesId}): ${json.error_message}`);
  const obs = json.observations;
  if (obs == null) return [];
  if (!Array.isArray(obs)) throw new Error(`${symbol} (${seriesId}): observations is not an array`);

  const out: DailyBar[] = [];
  for (const o of obs) {
    if (!o.date || o.value == null) continue;
    if (o.value === ".") continue; // no observation - a holiday, or not yet published
    const close = Number(o.value);
    if (!Number.isFinite(close)) continue;
    out.push({
      symbol,
      d: o.date,
      open: null,
      high: null,
      low: null,
      close,
      adj_close: null, // an index level has no dividend adjustment to make
      volume: null,
      source: FRED_SOURCE,
    });
  }
  return out;
}

export const fred: BarProvider = {
  name: FRED_SOURCE,
  minIntervalMs: MIN_INTERVAL_MS,

  supports(symbol: string): boolean {
    return symbol in SERIES;
  },

  async daily(symbol: string, range: Range): Promise<DailyBar[]> {
    const seriesId = SERIES[symbol];
    if (!seriesId) throw new Error(`${symbol}: no FRED series mapped - add it to SERIES`);

    const key = Deno.env.get("FRED_API_KEY");
    if (!key) throw new Error("FRED_API_KEY is not set on the function");

    // FRED takes the key as a query parameter; it has no header form.
    const url = `${observationsUrl(seriesId, range)}&api_key=${encodeURIComponent(key)}`;
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (r.status === 429) throw new RateLimitError(FRED_SOURCE, symbol);
    if (r.status === 400) {
      // FRED returns 400 for a bad key or a bad series id, with the reason in the body.
      throw new Error(`${symbol} (${seriesId}): HTTP 400 - bad api key or series id`);
    }
    if (!r.ok) throw new Error(`${symbol} (${seriesId}): HTTP ${r.status} from FRED`);

    return mapObservations(await r.json() as ObservationsResponse, symbol, seriesId);
  },

  // FRED publishes daily observations only.
  hourly(): Promise<HourlyBar[] | null> {
    return Promise.resolve(null);
  },
};
