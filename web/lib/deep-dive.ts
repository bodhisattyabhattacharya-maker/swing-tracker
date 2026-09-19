/**
 * deep-dive.ts — what one stock's analysis column contains, as data.
 *
 * PURE. No fetch, no env var, no secret; `scripts/ci/check_web_boundary.sh` rule 2 enforces that
 * for every module in this directory except `grid.ts`.
 *
 * Same argument as `lib/columns.ts` and `lib/market-history.ts`: the strip's structure is
 * configuration, so it lives where a server component and a client component can both read it, and
 * "what is in a stock column" is one list in one file rather than nine component bodies.
 *
 * ---------------------------------------------------------------------------
 * THE SECTIONS NAME PARAMS; THEY DO NOT REDEFINE THEM
 *
 * Every metric a section shows is named by its `param` and resolved against `COLUMNS`. An unknown
 * param THROWS at module load, the same way `columnsFor` refuses a preset that names one. The
 * alternative — a section carrying its own label, digits and suffix — is two catalogues that agree
 * on the day they are written, and the failure mode is a Deep Dive panel that says "RSI 14" beside
 * a number formatted to the wrong precision, or worse, a param string with a typo that renders a
 * permanently blank panel and looks like missing data.
 *
 * ---------------------------------------------------------------------------
 * A SECTION'S STATE IS DERIVED, NOT DECLARED
 *
 * `sectionState` reads the statuses of a section's own params: all planned means the section is
 * planned, anything live means it is live. Nothing declares it.
 *
 * That matters on one specific future day. When Phase 4 lands the financials ingest, the twenty
 * fundamental columns flip from `planned` to `live` in `columns.ts` — and the Fundamentals panel
 * here becomes live in the same commit, without anyone remembering this file exists. A declared
 * status would have stayed `planned`, and the panel would have kept saying the data was not built
 * while sitting directly above a grid rendering it. That is the shape of the matview-refresh bug
 * this project has now shipped three times: a second place that has to be updated by hand.
 */

import { COLUMNS, type Column, type Security } from "./columns";

/**
 * How wide one stock column is.
 *
 * 420px, from the specification. It is a CONSTANT and not a range: the whole point of the strip is
 * that the same section sits at the same height and the same width on every name, so the eye can
 * travel horizontally and compare one thing. A column that flexed to its content would put AVGO's
 * RSI gauge at a different y-offset from NVDA's, which is the one thing this layout exists to
 * prevent. 53 names at 420px is a 22,260px scroll, which is expected and is why the strip has its
 * own horizontal scroller rather than relying on the page.
 */
export const COLUMN_WIDTH = 420;

/** How a section renders. Each is a different component branch, not a styling variant. */
export type SectionKind =
  | "chart" // a price series, read per column through /api/stock-history
  | "gauges" // a bounded 0-100 scale with a norm band drawn on it
  | "rows" // label / value / verdict, one line per param
  | "bars"; // a signed magnitude against a zero line

export interface SectionSpec {
  key: string;
  title: string;
  /**
   * What the section measures, in one line. States the measurement, never how to read it.
   *
   * SHOWN AS HOVER TEXT ON THE HEADING, NOT AS BODY TEXT IN THE PANEL, and that was a correction
   * made from a screenshot. It is identical on every column by definition - it describes the
   * section, not the security - so rendering it in the panel printed the same two lines of grey
   * prose 22 times across the strip, 53 times in production. This layout multiplies anything
   * constant by the size of the watchlist, which is the same arithmetic that turned a per-cell
   * PLANNED tag into 312 of them on the Value preset (Bodhi, 2026-09-18: "header only is fine").
   * The numbers are the information; text that repeats identically is furniture.
   */
  sub: string;
  kind: SectionKind;
  /**
   * Params, resolved against COLUMNS. Order here is the order on screen.
   *
   * EMPTY means this section does not render columns at all — it renders a SERIES, which the
   * catalogue has no entry for. Only the price chart is like that: the grid publishes
   * `close_vs_sma50d`, a distance, and a candlestick panel needs the bars and the average itself.
   * Listing `close` here to make the section look anchored would have been worse than listing
   * nothing, because `close` was live while the chart was not — see `sectionState`, which got this
   * wrong on the first attempt for exactly that reason.
   */
  params: string[];
  /**
   * Present only on a section that cannot render yet, and it names the ACTUAL blocker in one
   * sentence. Three sections are blocked for three different reasons — one waits on a route this
   * change does not add, one on a vendor subscription, one on data that does not exist at any
   * vendor tier at all — and a reader deciding whether to wait or to stop waiting needs to know
   * which.
   *
   * REQUIRED on a planned section that renders params, and FORBIDDEN on a live one. Asserted at
   * module load, below, and that assertion is the point rather than tidiness: on the day Phase 4
   * flips the twenty fundamental columns to `live`, the sentence below saying "nobody has these
   * numbers here yet" becomes false. Deriving the state silently would have left that sentence on
   * screen under real data. Crashing the build makes someone read it.
   *
   * AND IT IS CAPPED AT `WHY_MAX` CHARACTERS, also asserted. The first version ran to 270 and the
   * screenshot showed why that is wrong here: a blocked panel appears on every column, so a
   * paragraph is printed once per security. The full reasoning belongs in the page's footnote,
   * which says it once; this field is the line that has to stand on its own in a 420px panel.
   */
  why?: string;
}

/**
 * The sections of one stock column, top to bottom.
 *
 * The order follows the specification's screenshots: the price picture first, then the three
 * timeframes of RSI, then the moving-average state, then the price statistics, then the weekly
 * panel, then relative strength, and the two fundamentals panels last because they are the ones
 * that do not exist yet and a reader should hit them after everything real.
 */
export const SECTIONS: SectionSpec[] = [
  {
    key: "price",
    title: "Price",
    sub: "Candles under a quarter in view, a line beyond it. EMA21 / SMA50 / SMA200, D or W.",
    kind: "chart",
    // No params, deliberately — see the field's comment. This panel draws a series, and a series is
    // not in the column catalogue. It reads through /api/stock-history when the column is scrolled
    // to, which is why it has no `why` any more: nothing is blocking it.
    params: [],
  },
  {
    key: "rsi",
    title: "RSI 14",
    sub: "Hourly, daily and weekly, each against its own norm band.",
    kind: "gauges",
    // Hourly first, matching the Technicals preset and the spec's screenshots: fastest at the top.
    // It is `planned`, so this section is live on two of three gauges and must say which.
    params: ["rsi_hourly", "rsi_daily", "rsi_weekly"],
  },
  {
    key: "ma",
    title: "Moving averages",
    sub: "Stack, both crosses with bars since, both slopes, and distance from each average.",
    kind: "rows",
    params: [
      "ma_stack",
      "cross_50_200",
      "cross_21_50",
      "sma50_slope",
      "sma200_slope",
      "close_vs_ema21d",
      "close_vs_sma50d",
      "close_vs_sma200d",
    ],
  },
  {
    key: "stats",
    title: "Price statistics",
    sub: "Distance from the highs and the low, realised volatility, volume against its average.",
    kind: "rows",
    params: [
      "pct_off_52w_high",
      "pct_off_high_stored",
      "pct_above_low_stored",
      "realized_vol_20",
      "volume_ratio",
    ],
  },
  {
    key: "weekly",
    title: "Weekly",
    sub: "On the last COMPLETED week, never the week in progress.",
    kind: "rows",
    params: ["rsi_weekly", "close_vs_ema21w", "close_vs_sma30w", "close_vs_sma200w"],
  },
  {
    key: "relative",
    title: "Relative strength",
    sub: "Percentage points against the S&P 500 over 63, 126 and 252 trading bars.",
    kind: "bars",
    params: ["rs_vs_spx_63b", "rs_vs_spx_126b", "rs_vs_spx_252b"],
  },
  {
    key: "fundamentals",
    title: "Fundamentals",
    sub: "Growth, margins, valuation and balance sheet, computed from filings.",
    kind: "rows",
    params: [
      "rev_growth_yoy",
      "eps_growth_yoy",
      "gross_margin_trend",
      "pe_trailing",
      "ev_ebitda",
      "fcf_yield",
      "roic",
      "net_debt_ebitda",
      "share_count_yoy",
    ],
    why: "Not built. Waiting on the financials ingest — nobody has these numbers here yet, not any name.",
  },
  {
    key: "forward",
    title: "Forward look",
    sub: "Consensus estimates. Opinion, carried with a source and an as-of date — never measured here.",
    kind: "rows",
    params: ["fwd_revenue", "fwd_eps", "fwd_pe", "fwd_peg", "analyst_target_gap", "days_to_earnings"],
    why: "Not built, and never computed here: no vendor tier carries consensus. These will be searched values.",
  },
];

/**
 * How long a blocked section's line may be.
 *
 * 120 characters, and the number is a consequence of the layout rather than a style preference:
 * this text is rendered once per column, so its cost is multiplied by the watchlist. At 420px and
 * 11.5px type, 120 characters is about two lines - enough for a statement, not enough for an
 * argument. The argument goes in the footnote under the strip, once.
 */
export const WHY_MAX = 120;

// ---------------------------------------------------------------------------
// Resolution. Done once, at module load, so a bad param name is a build-time crash rather than a
// blank panel that someone reports as missing data three weeks later.
// ---------------------------------------------------------------------------

const BY_PARAM = new Map(COLUMNS.map((c) => [c.param, c]));

export interface ResolvedSection extends SectionSpec {
  columns: Column[];
}

export const RESOLVED: ResolvedSection[] = SECTIONS.map((s) => ({
  ...s,
  columns: s.params.map((p) => {
    const c = BY_PARAM.get(p);
    if (!c) throw new Error(`deep-dive section ${s.key} names unknown param ${p}`);
    return c;
  }),
}));

/**
 * A section's state.
 *
 * TWO VALUES, deliberately. A third one meaning "the data exists but this release cannot read it"
 * would be unreachable the moment the release after it lands, and an unreachable state with its own
 * colour and its own CSS is the exact defect `check_cell_states.sh` was written to catch on
 * 2026-09-18 (the `na` cell state, unreachable across all 51 columns). The chart panel is `planned`
 * because from this page's point of view it is not built; its `why` carries the distinction that the
 * bars are already in the database, and prose costs no state machine.
 *
 * Both values stay permanently reachable, which is what keeps that CI check meaningful: the Forward
 * Look block has no source at any vendor tier, so `planned` does not disappear when Phase 4 lands.
 *
 * FOR A SECTION THAT RENDERS PARAMS, THIS IS DERIVED and nothing declares it — `live` if any of its
 * params reads real data today. That is what makes Phase 4 flip the Fundamentals panel in the same
 * commit that flips the columns, rather than leaving a hand-maintained copy of the same fact in a
 * second file. This project has shipped that bug three times with matview refresh lists.
 *
 * For a section that renders a series there are no params to derive from, so `why` decides.
 */
export type SectionState = "live" | "planned";

export function sectionState(s: ResolvedSection): SectionState {
  if (s.columns.length === 0) return s.why ? "planned" : "live";
  return s.columns.some((c) => c.status === "live") ? "live" : "planned";
}

/**
 * The invariant that keeps `why` honest, checked once at module load.
 *
 * A planned param section without a `why` renders a blank panel with nothing saying why it is
 * blank, which is indistinguishable on screen from a failed read. A live one that still carries a
 * `why` renders a stale excuse over real data, which is worse — it is the page lying about itself,
 * and it is precisely what would happen the day Phase 4 lands if this threw no error.
 *
 * At module load rather than in a test: this runs in the browser, in `next build`, and in CI,
 * so there is no configuration in which it is skipped.
 */
for (const s of RESOLVED) {
  // The clause that used to stand here required a series section to carry a `why`, because nothing
  // in the app could draw a series and the panel would otherwise have rendered a heading and then
  // nothing. `StockChart` now draws one, so the clause was deleted in the change that made it
  // false — which is the point of writing an invariant with its own expiry note rather than
  // leaving a rule behind that quietly outlives its reason.
  const state = sectionState(s);
  if (state === "planned" && !s.why) {
    throw new Error(
      `deep-dive section ${s.key} is planned (none of its ${s.columns.length} params is live) ` +
        `but has no "why". A blank panel with no reason reads as a failed read.`,
    );
  }
  if (s.why && s.why.length > WHY_MAX) {
    throw new Error(
      `deep-dive section ${s.key} has a ${s.why.length}-character "why"; the limit is ${WHY_MAX}. ` +
        `This line renders once per column, so a paragraph here is a paragraph per security. ` +
        `Put the reasoning in the page footnote and leave a statement here.`,
    );
  }
  if (state === "live" && s.why) {
    throw new Error(
      `deep-dive section ${s.key} now has live params but still carries a "why" saying it is ` +
        `blocked: "${s.why}". Rewrite or delete that sentence — it is about to render above real data.`,
    );
  }
}

/**
 * Which params in a live section are nonetheless not built, so the section can say so.
 *
 * The RSI section is the case this exists for: two of its three gauges read real numbers and the
 * hourly one cannot, because hourly bars are not session-aligned yet. A section that rendered two
 * gauges and silently dropped the third would be answering a question it was not asked.
 */
export function plannedWithin(s: ResolvedSection): Column[] {
  return s.columns.filter((c) => c.status === "planned");
}

/** Params of a section that do not apply to this security at all — an ETF has no income statement. */
export function notApplicableWithin(s: ResolvedSection, sec: Security): Column[] {
  return s.columns.filter((c) => c.applies && !c.applies(sec));
}

/**
 * What a section actually PUTS ON SCREEN for one security. Three outcomes, three sentences.
 *
 * ---------------------------------------------------------------------------
 * "NA" IS TESTED BEFORE "BLOCKED", AND THAT ORDERING IS THE WHOLE POINT
 *
 * This is the `cellState` ordering bug one level up, and it was caught the same way — by measuring
 * rather than by reading. The first version tested `planned` first, so SPY's Fundamentals panel read
 * "Blocked on the financials ingest, which is blocked on the Massive add-on and its four acceptance
 * probes". Every word of that is true about the panel and none of it is true about SPY: an ETF has
 * no income statement, so those nine questions will not apply to it after Phase 4 either. The
 * reader was told to wait for something that is never coming.
 *
 * The two facts are different in kind, exactly as they are for a cell. `applies` is permanent and
 * about the (security, param) pair. `status` is temporary and about the param alone. Report the
 * permanent one: it is already known and it will not change.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A FUNCTION HERE AND NOT AN `if` IN THE COMPONENT
 *
 * `scripts/ci/check_strip_sections.sh` has to know which cell states the strip can actually produce,
 * and that depends on which sections render data at all — a section that collapses to a sentence
 * renders no cells, so its params' states are not reachable no matter what `cellState` would return
 * for them. With the branching in the component, the check would have had to reimplement it, and a
 * check that reimplements the thing it checks agrees with it only on the day it is written. So the
 * component and the check call this.
 */
export type SectionRender = "na" | "blocked" | "data";

export function sectionRender(s: ResolvedSection, sec: Security): SectionRender {
  // Permanent before temporary. See above.
  if (s.columns.length > 0 && notApplicableWithin(s, sec).length === s.columns.length) return "na";
  // A series section has no params to derive from, so its `why` decides — and the price panel no
  // longer has one, which is exactly how it became live in this change without a second edit here.
  if (sectionState(s) === "planned") return "blocked";
  return "data";
}

// ---------------------------------------------------------------------------
// The RSI gauges.
// ---------------------------------------------------------------------------

/**
 * The RSI domain. Fixed at 0-100 because RSI is bounded there by construction, which is the whole
 * reason a gauge is the right shape for it and the wrong shape for, say, a percentage off the high.
 */
export const GAUGE_MIN = 0;
export const GAUGE_MAX = 100;

export interface GaugeGeometry {
  /** Where the value sits, as a percentage of the track width. Null when there is no value. */
  value: number | null;
  /** The norm band as left edge and width, both percentages. Null when the param has no norm. */
  band: { left: number; width: number } | null;
}

/**
 * Where to draw the marker and the band on a 0-100 track.
 *
 * THE BAND IS READ FROM THE NORM, NOT ASSUMED TO BE 30/70, and that is not a hypothetical: in
 * `config/norms.yml` today `rsi_daily` and `rsi_hourly` are 30/70 and **`rsi_weekly` is 40/70**.
 * Three gauges side by side with a hardcoded 30 would have drawn the weekly band ten points wide of
 * where the colouring actually changes — a chart disagreeing with the cell beside it about what the
 * rule is, which is the failure `lib/chart-theme.ts` exists to prevent for colour and this exists
 * to prevent for geometry.
 *
 * A one-sided norm is handled rather than excluded: the band runs from the bound to the end of the
 * track, because "≥ 40" genuinely means everything above 40 is inside.
 */
export function gaugeGeometry(
  value: number | null | undefined,
  norm: { low: number | null; high: number | null } | undefined,
): GaugeGeometry {
  const span = GAUGE_MAX - GAUGE_MIN;
  const pct = (v: number) => ((clamp(v) - GAUGE_MIN) / span) * 100;

  const v = typeof value === "number" && Number.isFinite(value) ? pct(value) : null;

  if (!norm || (norm.low === null && norm.high === null)) return { value: v, band: null };
  const left = norm.low !== null ? pct(norm.low) : 0;
  const right = norm.high !== null ? pct(norm.high) : 100;
  return { value: v, band: { left, width: Math.max(0, right - left) } };
}

/** Values outside 0-100 cannot happen for RSI, but a clamp is cheaper than a marker off the track. */
function clamp(v: number): number {
  return Math.min(GAUGE_MAX, Math.max(GAUGE_MIN, v));
}

// ---------------------------------------------------------------------------
// The relative-strength bars.
// ---------------------------------------------------------------------------

/**
 * How far from zero the RS bars can reach before they clip.
 *
 * ±60 percentage points, and this is a DISPLAY BOUND rather than a claim about the data. Real
 * 252-bar RS in this watchlist runs well past it — a name that tripled while the index rose 15%
 * shows +180pp — and a scale that fitted the largest value would squash every ordinary name into a
 * few pixels. So the bar clips and says it clipped, and the number beside it is always the real one.
 * The number is the fact; the bar is the glance.
 */
export const RS_BAR_LIMIT = 60;

export interface BarGeometry {
  /** Width as a percentage of the half-track. */
  width: number;
  /** Which way it points. */
  side: "pos" | "neg";
  /** True when the value ran past RS_BAR_LIMIT and the bar is showing the limit, not the value. */
  clipped: boolean;
}

export function barGeometry(value: number | null | undefined): BarGeometry | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const mag = Math.abs(value);
  const clipped = mag > RS_BAR_LIMIT;
  return {
    width: (Math.min(mag, RS_BAR_LIMIT) / RS_BAR_LIMIT) * 100,
    side: value < 0 ? "neg" : "pos",
    clipped,
  };
}

// ---------------------------------------------------------------------------
// Ordering the strip.
// ---------------------------------------------------------------------------

export interface StripSecurity extends Security {
  name: string;
  theme: string;
  bellwether: boolean;
}

/**
 * The order the columns appear in.
 *
 * Bellwethers first within a theme, then alphabetically, and themes in the order the ticker read
 * already returned them. NOT sorted by any parameter: this product has no score and no ranking
 * (hard constraint 1), and a strip ordered by RSI would be a ranking with extra steps. The theme
 * grouping is the only ordering that carries no verdict.
 */
export function stripOrder(secs: StripSecurity[]): StripSecurity[] {
  const themeRank = new Map<string, number>();
  for (const s of secs) if (!themeRank.has(s.theme)) themeRank.set(s.theme, themeRank.size);
  return secs.slice().sort((a, b) =>
    (themeRank.get(a.theme) ?? 99) - (themeRank.get(b.theme) ?? 99) ||
    Number(b.bellwether) - Number(a.bellwether) ||
    a.symbol.localeCompare(b.symbol)
  );
}

/** Where a theme changes, so the strip can rule between blocks the way the grid bands its rows. */
export function themeStarts(secs: StripSecurity[]): Set<string> {
  return new Set(
    secs.filter((s, i) => i === 0 || s.theme !== secs[i - 1].theme).map((s) => s.symbol),
  );
}
