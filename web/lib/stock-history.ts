/**
 * stock-history.ts — the contract for "one security's price series, at one timeframe".
 *
 * PURE. No fetch, no env var, no secret — both the chart and the route handler import it, which is
 * only safe because it stays that way. `check_web_boundary.sh` rule 2 enforces it.
 *
 * ---------------------------------------------------------------------------
 * SAME SHAPE AS `cell-history.ts`, AND FOR THE SAME REASON
 *
 * The browser asks for a series; a server route holding the service_role key answers. The one thing
 * that must never drift between those two programs is WHAT MAY BE ASKED. So the allowlist, the
 * views, the fixed `select` strings and the row caps all live here, and the route cannot express a
 * request this file has not approved.
 *
 * The difference from `cell-history.ts` is that a param allowlist does not apply: a price series is
 * not a catalogue parameter. What is bounded instead is the TIMEFRAME — two values, and they decide
 * which two relations are read.
 */

/** The two timeframes the Deep Dive offers. There is no third, and `hourly` is Phase 5. */
export type Timeframe = "d" | "w";

export const TIMEFRAMES: readonly Timeframe[] = ["d", "w"] as const;

export const TIMEFRAME_LABEL: Record<Timeframe, string> = { d: "Daily", w: "Weekly" };

/** One OHLC bar, as Lightweight Charts wants it (`time` is a yyyy-mm-dd string). */
export interface Bar {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** A moving-average overlay point. Sparse: warm-up bars have no average and are omitted. */
export interface LinePoint {
  time: string;
  value: number;
}

export interface OverlaySpec {
  /** Key in the stitched payload. */
  key: string;
  /** Shown in the chart's legend line. */
  label: string;
  /** Column in the features relation. Fixed strings; request input never reaches a select. */
  field: string;
}

/**
 * The averages drawn over the candles, per timeframe.
 *
 * These come from `daily_features` / `weekly_features` RATHER THAN being recomputed in the browser,
 * which matters for more than effort: the grid colours `close_vs_sma50d` against the same stored
 * average, so a recomputed overlay could sit a fraction away from the number in the panel below it
 * in the same column and there would be no way to tell which was right.
 *
 * Three on daily and three on weekly, matching the spec and the Technicals preset.
 */
export const OVERLAYS: Record<Timeframe, OverlaySpec[]> = {
  d: [
    { key: "ema21", label: "EMA21", field: "ema21_daily" },
    { key: "sma50", label: "SMA50", field: "sma50" },
    { key: "sma200", label: "SMA200", field: "sma200" },
  ],
  w: [
    { key: "ema21w", label: "EMA21W", field: "ema21_weekly" },
    { key: "sma30w", label: "SMA30W", field: "sma30w" },
    { key: "sma200w", label: "SMA200W", field: "sma200w" },
  ],
};

/**
 * How many bars one request may return.
 *
 * The paid plan carries five years, which is about 1,260 daily bars and 260 weekly ones, so these
 * are the whole stored history rather than a window. The panel opens on its shortest range and the
 * 5Y button shows all of it; one request serves every range, because re-reading on a button press
 * would put a round trip behind a control that should feel instant. The caps exist so the number is
 * bounded by a constant rather than by however much history the plan grows to.
 */
export const MAX_BARS: Record<Timeframe, number> = { d: 1400, w: 320 };

/**
 * The ranges the panel offers, per timeframe. The first is the default.
 *
 * ---------------------------------------------------------------------------
 * BUTTONS RATHER THAN PANNING, AND THE FIRST BUILD HAD IT WRONG
 *
 * The first version opened on a quarter and let you drag back through five years. It was measured
 * in a browser and the measurement killed it twice over.
 *
 * PANNING MOVES THE WINDOW; IT NEVER WIDENS IT. With zoom off — and zoom had to be off, because a
 * mouse wheel inside a horizontally scrolling strip is a fight over who gets the gesture — no
 * amount of dragging ever put more than 65 bars on screen. So the line mark, which exists exactly
 * for the case of more bars than pixels, could not be reached through the interface at all. That is
 * the unreachable-state bug again, and the CI check missed it because it asked whether the rule
 * *returns* "line" for a large bar count, not whether anything can produce that count.
 *
 * AND A DRAG INSIDE THIS STRIP IS AMBIGUOUS. The columns scroll horizontally; so did the chart.
 * Pressing the mouse down on a 390px canvas and moving sideways had two plausible meanings and the
 * reader could not tell which they would get.
 *
 * A range is also what Bodhi actually described — "candles in 3m or less views" — a view being
 * chosen, not scrolled into. Three buttons make that a decision with a visible current state.
 */
export interface RangeSpec {
  key: string;
  label: string;
  /** How many bars the view holds. `null` means everything stored. */
  bars: number | null;
}

export const RANGES: Record<Timeframe, RangeSpec[]> = {
  // 65 sessions is about three months; 252 is about a year. Named in bars in this file and in
  // months on the button, because bars are what the data has and months are what a reader thinks
  // in — the same split the project makes for `rs_vs_spx_126b`.
  d: [
    { key: "3m", label: "3M", bars: 65 },
    { key: "1y", label: "1Y", bars: 252 },
    { key: "5y", label: "5Y", bars: null },
  ],
  w: [
    { key: "1y", label: "1Y", bars: 52 },
    { key: "3y", label: "3Y", bars: 156 },
    { key: "5y", label: "5Y", bars: null },
  ],
};

/** How many bars a range actually shows, given how many exist. */
export function barsInRange(r: RangeSpec, available: number): number {
  return r.bars === null ? available : Math.min(r.bars, available);
}

/** Bars visible when the chart opens: the first range of the timeframe. */
export const OPENING_BARS: Record<Timeframe, number> = {
  d: RANGES.d[0].bars ?? 65,
  w: RANGES.w[0].bars ?? 52,
};

// ---------------------------------------------------------------------------
// THE MARK FOLLOWS THE DENSITY.
// ---------------------------------------------------------------------------

/**
 * The narrowest a candle may be and still be a candle.
 *
 * Five pixels: enough for a body with a wick either side of it. Below that the bodies merge and the
 * chart reads as a noisy line with none of a line's clarity — which is the actual reason this rule
 * exists rather than a preference. At the strip's 420px column the plot is about 390px wide, so
 * five pixels a bar puts the switch at 78 bars: a quarter plus three weeks.
 *
 * DERIVED FROM THE MEASURED WIDTH, NOT A FIXED BAR COUNT. A hardcoded 65 would be wrong the moment
 * a column is a different width — on a wider screen, in a future layout, or in the Dashboard's cell
 * sheet if this chart is ever reused there. The question "can a candle be seen" is about pixels.
 */
export const MIN_CANDLE_PX = 5;

export type Mark = "candles" | "line";

/**
 * Candles while each one gets its pixels; a line once they do not.
 *
 * Bodhi, 2026-09-19: "candles in 3m or less views. we can move to line beyond 3 months views".
 * Three months is about 63 trading bars, and at this column width the pixel rule lands at 78 —
 * close enough that the rule can be stated in the terms that actually govern it. The 3M button
 * lands under that and draws candles; 1Y and 5Y land over it and draw a line.
 */
export function markFor(barsInView: number, plotWidthPx: number): Mark {
  if (!Number.isFinite(barsInView) || barsInView <= 0) return "candles";
  if (!Number.isFinite(plotWidthPx) || plotWidthPx <= 0) return "candles";
  return plotWidthPx / barsInView >= MIN_CANDLE_PX ? "candles" : "line";
}

/** The bar count at which a given plot width stops being able to show candles. For captions. */
export function candleLimit(plotWidthPx: number): number {
  return Math.max(1, Math.floor(plotWidthPx / MIN_CANDLE_PX));
}

// ---------------------------------------------------------------------------
// What is read, and from where. Fixed strings; request input never reaches them.
// ---------------------------------------------------------------------------

/**
 * WEEKLY READS COMPLETED WEEKS ONLY, and the reason is not tidiness.
 *
 * `weekly_bars.is_complete` is defined as "this is not the newest week for this symbol" — so it is
 * false for the week in progress even on a Friday evening when the week is, in calendar terms,
 * over. The view cannot know whether another bar is coming.
 *
 * Drawing that forming week would put the candles one bar ahead of their own overlays, because
 * `weekly_features` computes its averages on completed weeks, and one bar ahead of the Weekly panel
 * sitting directly underneath it in the same column. A chart that disagrees with the numbers beside
 * it is worse than a chart that is a week short and says so. The spec says the same thing in
 * general terms: read the last completed week, never the week in progress.
 */
export const BARS: Record<Timeframe, { view: string; time: string; filter: string }> = {
  d: { view: "daily_bars", time: "d", filter: "" },
  w: { view: "weekly_bars", time: "week_start", filter: "&is_complete=eq.true" },
};

export const FEATURES: Record<Timeframe, { view: string; time: string; filter: string }> = {
  d: { view: "daily_features", time: "d", filter: "" },
  w: { view: "weekly_features", time: "week_start", filter: "&is_complete=eq.true" },
};

/** The columns each read asks for. Built from OVERLAYS so the two cannot drift. */
export function barSelect(tf: Timeframe): string {
  return `${BARS[tf].time},open,high,low,close`;
}

export function featureSelect(tf: Timeframe): string {
  return [FEATURES[tf].time, ...OVERLAYS[tf].map((o) => o.field)].join(",");
}

// ---------------------------------------------------------------------------
// Validation.
// ---------------------------------------------------------------------------

/** A ticker: upper-case letters, digits, dots, dashes, at most 8. Same rule as cell-history. */
const SYMBOL_RE = /^[A-Z][A-Z0-9.\-^]{0,7}$/;

export type Rejection = { ok: false; status: 400 | 404; message: string };
export type Acceptance = { ok: true; symbol: string; tf: Timeframe };

/**
 * Validate a request. The route touches the database only on `ok: true`.
 *
 * Named `validateRequest` deliberately: `check_web_boundary.sh` rule 5 requires every route handler
 * that reads the service_role key to call a function of that name, and requires that no request
 * value appear on a line with a query. Both rules apply to this route as written.
 */
export function validateRequest(
  symbolRaw: string | null,
  tfRaw: string | null,
): Acceptance | Rejection {
  const symbol = (symbolRaw ?? "").trim().toUpperCase();
  const tf = (tfRaw ?? "d").trim().toLowerCase();

  if (!symbol) return { ok: false, status: 400, message: "symbol is required" };
  if (!SYMBOL_RE.test(symbol)) return { ok: false, status: 400, message: "symbol is not a ticker" };
  if (!TIMEFRAMES.includes(tf as Timeframe)) {
    return { ok: false, status: 400, message: "timeframe must be d or w" };
  }
  return { ok: true, symbol, tf: tf as Timeframe };
}

/** The endpoint, in one place, so the client and any test agree on it. */
export function seriesUrl(symbol: string, tf: Timeframe): string {
  return `/api/stock-history?${new URLSearchParams({ symbol, tf }).toString()}`;
}

// ---------------------------------------------------------------------------
// Stitching.
// ---------------------------------------------------------------------------

export interface Series {
  symbol: string;
  tf: Timeframe;
  bars: Bar[];
  /** One sparse line per overlay, keyed by `OverlaySpec.key`. */
  overlays: Record<string, LinePoint[]>;
  error: string | null;
  /** Set when the newest stored bar is older than the grid's date — the panel says so. */
  lastBar: string | null;
}

/**
 * Join the bars to the averages BY DATE, IN THE HANDLER, rather than in SQL.
 *
 * MEASURED ON PRODUCTION, 2026-09-19, for NVDA over 260 bars:
 *
 *   daily_bars LEFT JOIN daily_features in SQL   9.7 ms   797 buffers
 *   daily_bars alone                             1.2 ms    17 buffers
 *   daily_features alone                         0.2 ms    16 buffers
 *
 * The join plan nested-loops 260 index lookups into `daily_features_pk` — correct, and 780 of those
 * 797 buffers. Two flat index scans and a hash in JavaScript is about seven times faster on a
 * twenty-fourth of the buffers, and needs no view. That is the same conclusion decision 0048
 * reached for the cell history, reached the same way: by measuring instead of assuming the database
 * is the cheaper place to put every join.
 *
 * LEFT JOIN FROM THE BARS SIDE. A bar inside its average's warm-up window has no average, and the
 * overlay must have a GAP there rather than a zero or a carried value — the same rule the market
 * history charts follow, and the same reason `ma20Points` refuses a partial average.
 */
export function stitch(
  tf: Timeframe,
  barRows: Array<Record<string, unknown>>,
  featureRows: Array<Record<string, unknown>>,
): { bars: Bar[]; overlays: Record<string, LinePoint[]> } {
  const tBar = BARS[tf].time;
  const tFeat = FEATURES[tf].time;

  const bars: Bar[] = [];
  for (const r of barRows) {
    const time = r[tBar];
    const o = r.open, h = r.high, l = r.low, c = r.close;
    if (typeof time !== "string") continue;
    if (typeof o !== "number" || typeof h !== "number" || typeof l !== "number" || typeof c !== "number") {
      continue;
    }
    bars.push({ time, open: o, high: h, low: l, close: c });
  }
  bars.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));

  const byTime = new Map<string, Record<string, unknown>>();
  for (const r of featureRows) {
    const t = r[tFeat];
    if (typeof t === "string") byTime.set(t, r);
  }

  const overlays: Record<string, LinePoint[]> = {};
  for (const spec of OVERLAYS[tf]) {
    const out: LinePoint[] = [];
    for (const bar of bars) {
      const v = byTime.get(bar.time)?.[spec.field];
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      out.push({ time: bar.time, value: v });
    }
    overlays[spec.key] = out;
  }
  return { bars, overlays };
}

/**
 * "3M · 65 of 627 sessions to 2026-09-18" — what is ON SCREEN, then what is held.
 *
 * The first version printed the range label and then the span of the WHOLE series: "3M of 627
 * sessions · 2024-04-25 → 2026-09-18", which reads as though the three-month view covered those
 * two and a half years. It does not; it covers the last 65 bars of them. A caption that misstates
 * what the reader is looking at is worse than no caption, and this one was caught by reading a
 * screenshot rather than by any assertion — the number was right and the sentence was wrong.
 */
export function rangeLabel(tf: Timeframe, range: RangeSpec, bars: Bar[]): string {
  if (bars.length === 0) return "no bars";
  const unit = tf === "d" ? "session" : "week";
  const n = bars.length;
  const shown = barsInRange(range, n);
  const held = n.toLocaleString("en-GB");
  const newest = bars[n - 1].time;
  return shown >= n
    ? `${range.label} · all ${held} ${unit}s to ${newest}`
    : `${range.label} · ${shown} of ${held} ${unit}s to ${newest}`;
}

/** The full stored span, for anywhere that wants it without a range. */
export function spanLabel(tf: Timeframe, bars: Bar[]): string {
  if (bars.length === 0) return "no bars";
  const unit = tf === "d" ? "session" : "completed week";
  const n = bars.length;
  return `${n.toLocaleString("en-GB")} ${unit}${n === 1 ? "" : "s"} · ${bars[0].time} → ${bars[n - 1].time}`;
}
