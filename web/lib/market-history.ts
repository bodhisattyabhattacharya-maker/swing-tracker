/**
 * market-history.ts — what the four market-history charts are, as data.
 *
 * PURE. No fetch, no env var, no secret; `scripts/ci/check_web_boundary.sh` rule 2 enforces that
 * for every module in this directory except `grid.ts`.
 *
 * Same argument as `lib/columns.ts`: the chart definitions are configuration, so they live where
 * both a server component and a client component can read them, and "what does this product plot"
 * is one list in one file rather than four component bodies.
 */

/** One row of `market_history`, as PostgREST returns it. */
export interface MarketRow {
  d?: string;
  vix?: number | null;
  vix_band?: string | null;
  vix3m?: number | null;
  term_structure?: number | null;
  spx_close?: number | null;
  breadth_pct?: number | null;
  breadth_tracked?: number | null;
  /** The 20-bar average of VIX, and how many bars it actually had. */
  vix_ma20?: number | null;
  vix_ma20_bars?: number | null;
}

export type ChartKey = "vix" | "regime" | "term" | "breadth";

export interface ChartSpec {
  key: ChartKey;
  title: string;
  /** One line, under the title. States what the chart measures, not how to read it. */
  sub: string;
  /** Pixel height. The four are deliberately not equal — see the grid in app/layout.tsx. */
  height: number;
  /** Shown in the detail line when the series has a norm band worth naming. */
  band?: string;
}

/**
 * The four charts, in the order they appear.
 *
 * The VIX chart is first and tallest because it is the one with a norm: 16 and 30 are the band from
 * `config/norms.yml`, the same numbers that colour the VIX tile above.
 *
 * WHAT A HORIZONTAL MEANS HERE, restated because the VIX chart now carries tints as well and the
 * old note ("none of them draws a threshold line") stopped being true.
 *
 *   A DASHED LINE WITH AN AXIS LABEL is a norm. The product has an opinion about it and colours a
 *   cell on it. Only the VIX chart has one.
 *   A CHANGE OF TINT is a label and nothing more. The 50 and 80 edges of the regime scale exist so
 *   the chart can describe a crisis; no cell anywhere is coloured by them, and retuning them
 *   changes no verdict. See REGIME_CUTS.
 *   A SOLID INK LINE is a definition. The term chart's zero is not a threshold anyone chose -
 *   backwardation IS below zero - so it is drawn as the fact it is.
 *
 * Three treatments because there are three different claims, and a reader who cannot tell them
 * apart would read the regime scale as five norms the product does not have.
 *
 * The breadth chart makes none of the three claims and draws no horizontal at all.
 */
export const CHARTS: ChartSpec[] = [
  {
    key: "vix",
    title: "VIX",
    sub: "Daily close with its 20-bar average. Tints are the regime scale; the dashed lines are the norm.",
    height: 200,
    band: "16 · 30",
  },
  {
    key: "regime",
    title: "Regime",
    sub: "Which band each session closed in, one mark per session.",
    // No time axis of its own - see MarketHistory. 46px is the strip plus its caption gap.
    height: 46,
  },
  {
    key: "term",
    title: "VIX term structure",
    sub: "3-month VIX over spot. Below zero is backwardation, filled and coloured.",
    height: 150,
  },
  {
    key: "breadth",
    title: "Breadth vs S&P 500",
    sub: "Share of watchlist companies above their own SMA200, against the index.",
    // 200, not 170: at 170 the left scale clipped its own bottom label. Two price scales and a
    // time axis need more vertical room than one, and this was measured on screen, not guessed.
    height: 200,
  },
];

/**
 * The VIX norm band, duplicated here as display metadata ONLY.
 *
 * These two numbers also live in `config/norms.yml`, which is the source of truth that decides
 * whether the VIX tile is coloured. They are repeated here because the chart needs to draw the band
 * and the page does not fetch norms for the market block — and that duplication is a real risk, so
 * it is named rather than hidden: a test in `supabase/functions/ingest/ingest_test.ts` reads this
 * file as text and asserts the pair equals the `vix` norm parsed from `config/norms.yml`. Retune
 * the norm and forget this constant and CI fails, rather than the chart drawing last month's band
 * across this month's data. (Not `check_formulas.sql` — that runs against the database and cannot
 * see a TypeScript constant.)
 */
export const VIX_BAND = { low: 16, high: 30 } as const;

/**
 * The minimum bars before `vix_ma20` means anything.
 *
 * `market_history` publishes `vix_ma20_bars` precisely so the page can refuse to draw a partial
 * average. Postgres will happily average a 3-row window and hand back a number that looks exactly
 * like a 20-day average; drawing it would be hard constraint 8 — "shown, never judged" — broken in
 * a new place, except worse, because a line has no way to say it is provisional.
 */
export const MA20_MIN_BARS = 20;

/** Rows with a usable 20-bar average, in chart order. */
export function ma20Points(rows: MarketRow[]): { time: string; value: number }[] {
  const out: { time: string; value: number }[] = [];
  for (const r of rows) {
    if (!r.d) continue;
    if (typeof r.vix_ma20 !== "number") continue;
    if (typeof r.vix_ma20_bars !== "number" || r.vix_ma20_bars < MA20_MIN_BARS) continue;
    out.push({ time: r.d, value: r.vix_ma20 });
  }
  return out;
}

/**
 * A numeric series, skipping rows where the value is absent.
 *
 * SKIPPING, not zero-filling, and not carrying the previous value forward. A gap in this data means
 * the index series had no publication that day — FRED runs behind the equities, which is the whole
 * reason the market tiles each carry their own as-of date (decision 0034). A zero would draw VIX
 * collapsing to nothing; a carried value would draw a flat day that did not happen.
 */
export function points(
  rows: MarketRow[],
  field: "vix" | "vix3m" | "term_structure" | "spx_close" | "breadth_pct",
): { time: string; value: number }[] {
  const out: { time: string; value: number }[] = [];
  for (const r of rows) {
    const v = r[field];
    if (!r.d || typeof v !== "number") continue;
    out.push({ time: r.d, value: v });
  }
  return out;
}

export type Regime = "calm" | "normal" | "high" | "stress" | "extreme" | "unknown";

/**
 * The two cut points ABOVE the norm. **These are not norms**, and the distinction is the whole
 * reason they have their own constant.
 *
 * 16 and 30 come from `config/norms.yml`, they decide whether the VIX tile is coloured, and CI
 * pins `VIX_BAND` to them. 50 and 80 decide nothing: no cell is coloured by them, no verdict reads
 * them, and retuning them changes only how the regime strip is labelled. They exist because a
 * scale that stops at 30 cannot describe March 2020, and a chart that cannot describe its own
 * worst case is a chart that will be wrong exactly when it is being read hardest.
 *
 * On screen the difference is visible: the two norm edges are drawn as dashed lines with axis
 * labels, the display cuts only as a change of tint. A reader can see which boundaries the product
 * has an opinion about.
 */
export const REGIME_CUTS = { high: 50, stress: 80 } as const;

export interface RegimeBand {
  key: Exclude<Regime, "unknown">;
  /** The word under the strip and beside the band. Lowercase; the stylesheet decides the case. */
  label: string;
  lo: number | null;
  hi: number | null;
  /**
   * WHICH BAND OWNS AN EDGE, stated rather than implied.
   *
   * This was implicit until the scale check probed it, and the answer was wrong: both `calm` and
   * `normal` claimed 16, `regimeOf` returned whichever came first in the list, and it returned
   * `calm` — while the VIX tile, colouring off the same norm, treats exactly 16 as INSIDE the
   * band. One session could therefore be calm on the strip and unremarkable on the tile.
   *
   * The ownership is genuinely not uniform, which is why it has to be written down. The norm is a
   * CLOSED interval — the tile is uncoloured at 16 and at 30 and coloured either side — so
   * `normal` owns both of its edges, and every band outside it owns its upper edge only. Any
   * single "always round up" or "always round down" rule gets one of the two wrong.
   */
  loInclusive: boolean;
  hiInclusive: boolean;
  /** True when at least one edge is the norm rather than a display cut. */
  fromNorm: boolean;
  /** "16 – 30", "> 80". For the legend and the band label. */
  range: string;
}

/**
 * The five bands, low to high.
 *
 * BOUNDARY SEMANTICS ARE THE NORM'S, NOT A NEW ONE. `normal` is 16 to 30 **inclusive at both
 * ends**, because that is what `regimeOf` has always done and what colours the VIX tile: the tile
 * is uncoloured at exactly 30 and coloured at 30.01. Redefining the edge here would have made the
 * strip and the tile disagree about the same session, which is the defect class this project has
 * shipped most often.
 */
export const REGIME_BANDS: RegimeBand[] = [
  { key: "calm", label: "calm", lo: null, hi: VIX_BAND.low,
    loInclusive: false, hiInclusive: false, fromNorm: true,
    range: `< ${VIX_BAND.low}` },
  { key: "normal", label: "normal", lo: VIX_BAND.low, hi: VIX_BAND.high,
    loInclusive: true, hiInclusive: true, fromNorm: true,
    range: `${VIX_BAND.low} – ${VIX_BAND.high}` },
  { key: "high", label: "high", lo: VIX_BAND.high, hi: REGIME_CUTS.high,
    loInclusive: false, hiInclusive: true, fromNorm: true,
    range: `${VIX_BAND.high} – ${REGIME_CUTS.high}` },
  { key: "stress", label: "stress", lo: REGIME_CUTS.high, hi: REGIME_CUTS.stress,
    loInclusive: false, hiInclusive: true, fromNorm: false,
    range: `${REGIME_CUTS.high} – ${REGIME_CUTS.stress}` },
  { key: "extreme", label: "extreme", lo: REGIME_CUTS.stress, hi: null,
    loInclusive: false, hiInclusive: false, fromNorm: false,
    range: `> ${REGIME_CUTS.stress}` },
];

/** Whether a value falls in a band, honouring which side owns each edge. */
export function inBand(b: RegimeBand, v: number): boolean {
  if (b.lo !== null && !(b.loInclusive ? v >= b.lo : v > b.lo)) return false;
  if (b.hi !== null && !(b.hiInclusive ? v <= b.hi : v < b.hi)) return false;
  return true;
}

/**
 * The scale must be strictly increasing, and it is asserted at module load rather than assumed.
 *
 * The norm is retunable — that is the point of `config/norms.yml` — and nothing stops someone
 * setting the VIX band to 40/60 after a bad year. That would leave `high` running from 60 down to
 * 50, a band with negative width that silently swallows every session above 60. Throwing here
 * turns that into a build failure instead of a chart that quietly stops counting the sessions that
 * matter most.
 */
{
  const edges = [VIX_BAND.low, VIX_BAND.high, REGIME_CUTS.high, REGIME_CUTS.stress];
  for (let i = 1; i < edges.length; i++) {
    if (!(edges[i] > edges[i - 1])) {
      throw new Error(
        `market-history: the regime scale is not increasing (${edges.join(" < ")} is false). ` +
          `VIX_BAND comes from config/norms.yml; REGIME_CUTS is display-only. One of them moved.`,
      );
    }
  }
}

/**
 * Which band a session closed in.
 *
 * Derived from the VALUE and the band list, not from `market_context.vix_band` — that column is a
 * text label built for the digest ("16-30"), and parsing a label to recover the numbers it was
 * rendered from is how a display string becomes an accidental API.
 */
export function regimeOf(vix: number | null | undefined): Regime {
  if (typeof vix !== "number" || !Number.isFinite(vix)) return "unknown";
  for (const b of REGIME_BANDS) if (inBand(b, vix)) return b.key;
  // Unreachable while the bands tile the line, which `scripts/ci/check_regime_scale.sh` asserts
  // by requiring exactly one band to claim every edge. Kept as a loud failure rather than a
  // silent fall-through to the last band, which would quietly relabel a session.
  throw new Error(`market-history: VIX ${vix} fell through the regime scale`);
}

/** How many sessions in each band. Every key present, including the zeros. */
export function regimeCounts(rows: MarketRow[]): Record<Regime, number> {
  const c = {
    calm: 0, normal: 0, high: 0, stress: 0, extreme: 0, unknown: 0,
  } as Record<Regime, number>;
  for (const r of rows) c[regimeOf(r.vix)]++;
  return c;
}

/**
 * The bands that actually occurred, in scale order, for the legend.
 *
 * ONLY THE ONES WITH SESSIONS IN THEM (Bodhi, 2026-09-20). Over the window this panel draws the
 * split is 33 / 91 / 2 / 0 / 0, and `stress` and `extreme` will be empty in almost every window
 * this product ever renders — VIX has closed above 80 on one day in the eleven years of index
 * history we hold. A legend entry reading "stress 0" would occupy a line of the caption
 * permanently in order to describe nothing, which is the unreachable-state problem in visual form.
 *
 * The SCALE still has five bands: `regimeOf` classifies into all of them and the strip draws all
 * of them, so the first session above 50 is coloured correctly the moment it arrives. What is
 * conditional is only the caption.
 */
export function regimesPresent(
  rows: MarketRow[],
): Array<{ band: RegimeBand; count: number }> {
  const counts = regimeCounts(rows);
  return REGIME_BANDS
    .filter((b) => counts[b.key] > 0)
    .map((b) => ({ band: b, count: counts[b.key] }));
}

/**
 * Where each band sits in a chart's plot area, in pixels, for the tint behind the VIX line.
 *
 * TAKES A MAPPING FUNCTION RATHER THAN A CHART. The caller passes the series' own
 * `priceToCoordinate`, so this stays pure and can be exercised against a synthetic linear scale —
 * which is the only way to test the clamping, since a real chart needs a DOM and a paint.
 *
 * Bands entirely outside the plot are dropped rather than clamped to nothing. With VIX topping out
 * near 31, `stress` and `extreme` are above the visible range every day, and returning them with
 * zero height would have the component render two invisible elements carrying two labels.
 */
export function bandRects(
  toY: (price: number) => number | null,
  plotTop: number,
  plotBottom: number,
): Array<RegimeBand & { top: number; height: number }> {
  if (!(plotBottom > plotTop)) return [];
  const clamp = (y: number) => Math.min(Math.max(y, plotTop), plotBottom);
  const out: Array<RegimeBand & { top: number; height: number }> = [];
  for (const b of REGIME_BANDS) {
    // A null edge is open-ended, so it runs to the edge of the plot. A non-null edge the scale
    // cannot place is treated the same way: off the top for the upper edge, off the bottom for
    // the lower one, which is where an unplaceable price necessarily is.
    const yHi = b.hi === null ? plotTop : toY(b.hi) ?? plotTop;
    const yLo = b.lo === null ? plotBottom : toY(b.lo) ?? plotBottom;
    const top = clamp(Math.min(yHi, yLo));
    const bottom = clamp(Math.max(yHi, yLo));
    const height = bottom - top;
    // Under a pixel is not a band; it is a rounding artefact at the edge of the plot.
    if (height < 1) continue;
    out.push({ ...b, top, height });
  }
  return out;
}

/**
 * The eight chips under the panel: what this window actually did.
 *
 * EVERY ONE IS A READING OR A COUNT. Nothing here is a percentile, a z-score or a rank, and that
 * was the choice (Bodhi, 2026-09-20) over a set that paired each current value with where it sat
 * in the window's range. A percentile is a derived quantity this page computes nowhere else, and
 * it invites the reading "today is unusual", which is a judgement the market block does not make.
 * A count of sessions is a fact about the window with nothing added.
 *
 * Two of the eight are counts precisely because the charts are worst at them: a reader can see the
 * term-structure line dip below zero but cannot tell whether that was four sessions or fourteen
 * without tracing it, and the number of sessions above the VIX band is invisible on a strip that
 * shows them as two pixels of colour.
 *
 * A chip whose value cannot be computed says so in words. It never shows a dash alone, because on
 * this page a dash already means "no value for this name" in a grid cell, and it never shows 0,
 * because zero sessions and no data are different facts.
 */
export interface Stat {
  key: string;
  label: string;
  /** Already formatted, including any suffix. The empty state is a word, not a dash. */
  value: string;
  /** Present when the value needs a qualifier — the count of sessions it was taken over. */
  note?: string;
}

function lastOf(rows: MarketRow[], field: "vix" | "term_structure" | "breadth_pct"): number | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const v = rows[i][field];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function allOf(rows: MarketRow[], field: "vix" | "term_structure" | "breadth_pct"): number[] {
  return rows
    .map((r) => r[field])
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

const n1 = (v: number | null, suffix = "") => v === null ? "not published" : v.toFixed(1) + suffix;

export function windowStats(rows: MarketRow[]): Stat[] {
  const vix = allOf(rows, "vix");
  const term = allOf(rows, "term_structure");
  const breadth = allOf(rows, "breadth_pct");
  const ma = ma20Points(rows);

  // Counted over the sessions that HAVE a value, and the note says how many those were whenever it
  // is fewer than the window. "6 sessions" out of 126 and out of 12 are different claims.
  const countNote = (had: number) =>
    had === rows.length ? undefined : `of ${had} with a value`;

  return [
    {
      key: "vix_last",
      label: "VIX last",
      value: n1(lastOf(rows, "vix")),
    },
    {
      key: "vix_ma20",
      label: "VIX 20-bar avg",
      // The same refusal `ma20Points` makes: an average over fewer than 20 bars is not a 20-bar
      // average, however much it looks like one.
      value: ma.length === 0 ? "under 20 bars" : ma[ma.length - 1].value.toFixed(1),
    },
    {
      key: "vix_high",
      label: "VIX window high",
      value: vix.length === 0 ? "not published" : Math.max(...vix).toFixed(1),
    },
    {
      key: "vix_above",
      label: "Sessions above band",
      value: vix.length === 0
        ? "not published"
        : String(vix.filter((v) => v > VIX_BAND.high).length),
      note: vix.length === 0 ? undefined : countNote(vix.length),
    },
    {
      key: "term_last",
      label: "Term structure last",
      value: n1(lastOf(rows, "term_structure"), "%"),
    },
    {
      key: "term_back",
      label: "Sessions backwardated",
      value: term.length === 0 ? "not published" : String(term.filter((v) => v < 0).length),
      note: term.length === 0 ? undefined : countNote(term.length),
    },
    {
      key: "breadth_last",
      label: "Breadth last",
      value: (() => {
        const v = lastOf(rows, "breadth_pct");
        return v === null ? "nobody eligible" : `${Math.round(v)}%`;
      })(),
    },
    {
      key: "breadth_range",
      label: "Breadth range",
      value: breadth.length === 0
        ? "nobody eligible"
        : `${Math.round(Math.min(...breadth))} – ${Math.round(Math.max(...breadth))}%`,
    },
  ];
}

/** "2026-03-20 → 2026-09-17 · 126 sessions", or a plain statement that there is nothing to draw. */
export function spanLabel(rows: MarketRow[]): string {
  const dates = rows.map((r) => r.d).filter((x): x is string => !!x);
  if (dates.length === 0) return "no sessions";
  const n = dates.length;
  return `${dates[0]} → ${dates[n - 1]} · ${n} session${n === 1 ? "" : "s"}`;
}
