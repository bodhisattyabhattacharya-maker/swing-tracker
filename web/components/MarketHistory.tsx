"use client";

/**
 * MarketHistory — the four market-history charts, under the market tiles.
 *
 * A CLIENT COMPONENT, because Lightweight Charts draws to a canvas and a canvas needs a DOM. It
 * imports `lib/market-history.ts` and `lib/chart-theme.ts`, both pure. It must NEVER import
 * `lib/grid.ts`, which holds the service_role key; rows arrive as props.
 * `scripts/ci/check_web_boundary.sh` fails the build on that import rather than trusting this line.
 *
 * ---------------------------------------------------------------------------
 * WHY A COLLAPSIBLE PANEL, CLOSED BY DEFAULT
 *
 * The grid is the product. Four charts above it would push 53 rows below the fold on every load to
 * show context that changes once a day and that the four tiles already summarise. So the panel is
 * shut until asked for, and the charts are not built until it opens — `createChart` on a hidden
 * element measures zero width and draws nothing, which is not a bug to work around but a reason to
 * mount lazily anyway.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE CHARTS MUST NOT DO
 *
 *   - They must not draw `vix_ma20` before it has 20 bars. The average exists from bar 1 and is
 *     mostly its own seed until bar 20; `market_history` publishes the count so this file can
 *     refuse. See MA20_MIN_BARS.
 *   - They must not bridge a gap. A missing session is a missing publication, not a flat day.
 *   - They must not draw a threshold on a series that has no norm. A line across a chart reads as
 *     a rule; only VIX has one.
 *   - They must not carry their own palette. Colours are read off the page, so a chart cannot
 *     disagree with the cell beside it, and so both themes work without a second set of literals.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AreaSeries,
  BaselineSeries,
  type ISeriesApi,
  type IChartApi,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
} from "lightweight-charts";
import {
  baseChartOptions,
  type ChartTheme,
  readTheme,
  watchTheme,
} from "../lib/chart-theme";
import {
  CHARTS,
  MA20_MIN_BARS,
  type MarketRow,
  ma20Points,
  points,
  bandRects,
  type RegimeBand,
  regimeCounts,
  regimeOf,
  regimesPresent,
  spanLabel,
  VIX_BAND,
  windowStats,
} from "../lib/market-history";

export interface Props {
  rows: MarketRow[];
  /** Set when the history could not be read. Rendered as a sentence, never as an empty chart. */
  error: string | null;
  /** The grid's own date, so the panel can say when the series ends earlier. */
  gridDate: string | null;
}

export default function MarketHistory({ rows, error, gridDate }: Props) {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<ChartTheme | null>(null);

  // The palette is read after mount and re-read whenever the OS scheme or a data-theme attribute
  // changes. Until it is read, nothing is drawn: a chart built against the server-side fallback
  // would be light-mode-coloured on a dark page for one frame, which is exactly the flash this
  // whole indirection exists to avoid.
  useEffect(() => {
    setTheme(readTheme());
    return watchTheme(setTheme);
  }, []);

  const last = rows.length > 0 ? rows[rows.length - 1].d ?? null : null;
  const counts = regimeCounts(rows);
  const present = regimesPresent(rows);
  const stats = windowStats(rows);

  return (
    <section className="mh">
      <button
        className="mh-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="chev">{open ? "▾" : "▸"}</span>
        <span className="mh-t">Market history</span>
        <span className="mh-span">{spanLabel(rows)}</span>
        {last && gridDate && last !== gridDate
          ? <span className="mh-asof">series ends {last}</span>
          : null}
      </button>

      {open
        ? (
          error
            ? (
              <div className="market-err mh-err">
                <b>The market history could not be read.</b>{" "}
                Everything else on this page is unaffected. <span className="err">{error}</span>
              </div>
            )
            : rows.length === 0
            ? (
              <p className="note mh-note">
                No history rows came back. The four tiles above read a different view, so they may
                still be current — this panel is not evidence about them either way.
              </p>
            )
            : (
              <>
                <div className="mh-grid">
                  {CHARTS.map((c) => (
                    <figure key={c.key} className={`mh-fig mh-${c.key}`}>
                      <figcaption>
                        <span className="mh-ft">{c.title}</span>
                        {c.band ? <span className="mh-fb">norm {c.band}</span> : null}
                        <span className="mh-fs">{c.sub}</span>
                      </figcaption>
                      {theme
                        ? <Chart kind={c.key} rows={rows} theme={theme} height={c.height} />
                        : <div className="mh-hold" style={{ height: c.height }} />}
                    </figure>
                  ))}
                </div>
                {/* WHAT THE WINDOW DID, in eight readings and counts. Two of them are counts
                    because the charts are worst at counts: the term-structure line visibly dips
                    below zero, but whether that was four sessions or fourteen cannot be read off
                    it without tracing. See windowStats in lib/market-history.ts. */}
                <dl className="mh-stats">
                  {stats.map((st) => (
                    <div key={st.key} className="mh-stat">
                      <dt>{st.label}</dt>
                      <dd>
                        {st.value}
                        {st.note ? <span className="mh-stat-n">{st.note}</span> : null}
                      </dd>
                    </div>
                  ))}
                </dl>
                <p className="note mh-note">
                  <span className="mh-legend">
                    {/* Only the bands with sessions in them. The SCALE still has five and the
                        strip draws all five; what is conditional is this line. A legend entry
                        reading "stress 0" would describe nothing, permanently. */}
                    {present.map(({ band, count }) => (
                      <span key={band.key} className="mh-leg">
                        <i className={`mh-swatch r-${band.key}`} />
                        {band.label} <b>{count}</b>
                        <span className="mh-leg-r">{band.range}</span>
                      </span>
                    ))}
                    {counts.unknown > 0
                      ? (
                        <span className="mh-leg">
                          <i className="mh-swatch r-unknown" />
                          no VIX publication <b>{counts.unknown}</b>
                          <span className="mh-leg-r">drawn as gaps</span>
                        </span>
                      )
                      : null}
                  </span>
                  The 20-bar average starts at its {MA20_MIN_BARS}th session, not its first — before
                  that it is mostly its own seed, so it is not drawn.
                </p>
              </>
            )
        )
        : null}
    </section>
  );
}

/**
 * One chart. Created on mount, destroyed on unmount, rebuilt when the palette changes.
 *
 * REBUILT, not restyled, on a theme change. `applyOptions` can update most colours but not the
 * per-point colours of the regime histogram, and a half-updated chart is worse than a rebuilt one.
 * This happens when someone's OS flips light/dark — once, not per frame.
 */
function Chart(
  { kind, rows, theme, height }: {
    kind: "vix" | "regime" | "term" | "breadth";
    rows: MarketRow[];
    theme: ChartTheme;
    height: number;
  },
) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  // Held so the band overlay can ask the VIX series where a price is. Only the VIX chart sets it.
  const vixSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const [bands, setBands] = useState<Array<RegimeBand & { top: number; height: number }>>([]);
  const [inset, setInset] = useState(0);

  /**
   * Place the regime tints behind the VIX line.
   *
   * HTML OVER THE CANVAS, NOT A CANVAS PRIMITIVE. Lightweight Charts has no horizontal band, and
   * the two ways to fake one on the canvas are both worse: a filled series would appear in the
   * crosshair readout as a value the reader can hover, and a thick price line cannot carry a
   * label. These are five rectangles and five words that never animate, which is what HTML is
   * for; the chart's own background is transparent, so they show through.
   *
   * Recomputed rather than remembered. The price scale is auto-fitted to the data, so the same
   * band is at a different height whenever the window or the width changes.
   */
  const syncBands = useCallback(() => {
    if (kind !== "vix") return;
    const c = chart.current;
    const sv = vixSeries.current;
    if (!c || !sv) return;
    // The plot stops above the time axis; without this the lowest band would run under the dates.
    const plotBottom = height - c.timeScale().height();
    setBands(bandRects((price) => sv.priceToCoordinate(price), 0, plotBottom));
    // And stops short of the price axis on the right, or a tint would sit under its labels.
    setInset(c.priceScale("right").width());
  }, [kind, height]);

  const build = useCallback(() => {
    const el = box.current;
    if (!el) return;
    // A chart on a zero-width element draws nothing and never recovers on its own, so it is not
    // built until the element has a width. The ResizeObserver below calls back in.
    const w = el.clientWidth;
    if (w === 0) return;

    chart.current?.remove();
    const c = createChart(el, { ...baseChartOptions(theme), width: w, height });
    chart.current = c;

    if (kind === "vix") {
      const vix = c.addSeries(LineSeries, {
        color: theme.ink,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      vix.setData(points(rows, "vix"));
      vixSeries.current = vix;
      // The norm band, as two threshold lines on the series that HAS a norm. Same two numbers as
      // the VIX tile's colouring, from lib/market-history.ts, which CI pins to config/norms.yml.
      // No `title`. `axisLabelVisible` already prints the value on the price axis; a title printed
      // it again immediately beside it, so the axis read "30  30.00" and "16  16.00".
      for (const v of [VIX_BAND.low, VIX_BAND.high]) {
        vix.createPriceLine({
          price: v,
          color: theme.rule,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: "",
        });
      }
      const ma = c.addSeries(LineSeries, {
        color: theme.accent,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      ma.setData(ma20Points(rows));
    }

    if (kind === "regime") {
      // A colour strip, not a value chart: every bar is height 1 and the meaning is entirely in the
      // colour. Hence no price scale and no horizontal grid - a y-axis reading "1" would invite a
      // reader to look for a quantity that is not there.
      const strip: ISeriesApi<"Histogram"> = c.addSeries(HistogramSeries, {
        priceLineVisible: false,
        lastValueVisible: false,
        priceFormat: { type: "volume" },
      });
      // FULL-SATURATION TONES, NOT THE -bg TINTS. Learned on screen when this strip had three
      // states rather than five: the first version used the cell-background tints, which are
      // near-white by design because they sit behind dark text, and on a pale panel a strip of 91
      // ordinary sessions and 33 calm ones was indistinguishable from the panel itself. Only the
      // 2 sessions above the band showed. A chart built to display a distribution displayed one
      // value of it. A tint that works as a background does not work as a mark, and that holds
      // for all five bands now.
      //
      // THE INTENSITY RAMP, NOT THE VERDICT PAIR. Five bands since 2026-09-20 (decision 0054),
      // anchored at its ends on --calm and --stress so the strip is the VIX tile's colouring in
      // timeline form rather than a second vocabulary that resembles it. Red and green are
      // reserved for "outside a norm we set": with verdicts at muted red and green, a calm tape
      // would have painted red and a stressed one green. See the note above MARKET_TILES.
      const REGIME_INK: Record<string, string> = {
        calm: theme.regCalm,
        normal: theme.regNormal,
        high: theme.regHigh,
        stress: theme.regStress,
        extreme: theme.regExtreme,
        // A session with no VIX publication. Transparent, so the gap is a gap - the same rule the
        // line charts follow by skipping the point rather than bridging it.
        unknown: "rgba(0,0,0,0)",
      };
      const colourFor = (r: MarketRow) => REGIME_INK[regimeOf(r.vix)] ?? REGIME_INK.unknown;
      strip.setData(
        rows
          .filter((r) => !!r.d)
          .map((r) => ({ time: r.d as string, value: 1, color: colourFor(r) })),
      );
      c.applyOptions({
        rightPriceScale: { visible: false },
        grid: { horzLines: { visible: false }, vertLines: { visible: false } },
        // No axis of its own. It sits directly beneath the VIX chart, over the same sessions, and
        // a second copy of the same months in 46px of height was most of the height.
        timeScale: { visible: false },
      });
    }

    if (kind === "term") {
      // A BASELINE SERIES, NOT AN AREA, AND THE DIFFERENCE WAS A REAL DEFECT.
      //
      // This was an AreaSeries with topColor/bottomColor set to the verdict tints and a comment
      // saying it was "anchored at zero". It was not. An AreaSeries fills from the line down to
      // the BOTTOM OF THE PANE and paints that fill as a vertical gradient from topColor to
      // bottomColor, so the colours described a pixel's height in the box and nothing else: a
      // session at +29.5% and one at -5.7% got the same treatment. The chart's own comment, the
      // spec and the reader all believed it said something about the sign. It did not.
      //
      // BaselineSeries splits at baseValue and colours the two sides separately, which is the
      // thing that was meant all along. Backwardation now reads as a muted stress fill and
      // contango as a near-neutral one - deliberately unequal, because backwardation is the rare
      // state worth noticing (6 of the 126 sessions in the current window) and contango is the
      // background condition, not an achievement.
      const term = c.addSeries(BaselineSeries, {
        baseValue: { type: "price", price: 0 },
        topLineColor: theme.ink,
        topFillColor1: theme.ruleSoft,
        topFillColor2: theme.ruleSoft,
        bottomLineColor: theme.stress,
        bottomFillColor1: theme.stressBg,
        bottomFillColor2: theme.stressBg,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      term.setData(points(rows, "term_structure"));
      // THE ZERO LINE IS THE REFERENCE, so it is drawn in ink rather than in the faint grey it had.
      // Every other horizontal on this chart is a grid line; this one is the thing the fills are
      // measured against, and at --ink-faint it was the same weight as the gridlines behind it.
      term.createPriceLine({
        price: 0,
        color: theme.ink,
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: "",
      });
    }

    if (kind === "breadth") {
      // TWO SCALES, because these are two units: a percentage of our own watchlist and an index
      // level. Forcing them onto one axis would make the shapes comparable and the values nonsense.
      // AN AREA FOR BREADTH, A LINE FOR THE INDEX, because they are not the same kind of
      // quantity. Breadth is a share of a fixed population - it has a floor at 0 and a ceiling at
      // 100, so the filled region below it means something: that is the part of the watchlist
      // above its own average. An index level has no meaningful zero to fill down to, so filling
      // it would draw a large shape whose area is an artefact of where the axis happens to start.
      const breadth = c.addSeries(AreaSeries, {
        lineColor: theme.accent,
        topColor: theme.aboveBg,
        bottomColor: "rgba(0,0,0,0)",
        lineWidth: 2,
        priceScaleId: "left",
        priceLineVisible: false,
        lastValueVisible: false,
      });
      breadth.setData(points(rows, "breadth_pct"));
      const spx = c.addSeries(LineSeries, {
        color: theme.inkFaint,
        lineWidth: 1,
        priceScaleId: "right",
        priceLineVisible: false,
        lastValueVisible: false,
      });
      spx.setData(points(rows, "spx_close"));
      // BOTTOM MARGIN 0.16 ON BOTH SCALES, not the shared 0.08. Measured on screen: at 0.08 the
      // left scale's lowest label ("40.00") was half-clipped by the canvas edge, because two price
      // scales and a time axis leave less room below the plot than one does. The margin is per
      // chart rather than raised globally, so the VIX chart's band labels stay where they are.
      c.applyOptions({
        leftPriceScale: { visible: true, borderColor: theme.rule, scaleMargins: { top: 0.12, bottom: 0.16 } },
        rightPriceScale: { borderColor: theme.rule, scaleMargins: { top: 0.12, bottom: 0.16 } },
      });
    }

    c.timeScale().fitContent();
    // After a frame, not now: the price scale has not been laid out yet at this point, so
    // priceToCoordinate returns coordinates from the previous fit - which on the first build is
    // no fit at all, and every band lands at zero height and is dropped.
    requestAnimationFrame(syncBands);
  }, [kind, rows, theme, height, syncBands]);

  useEffect(() => {
    build();
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const c = chart.current;
      const w = el.clientWidth;
      if (!c) {
        // Never built, because the element had no width when the panel opened. Build now.
        build();
        return;
      }
      if (w > 0) {
        c.applyOptions({ width: w });
        // A width change re-fits the price scale, so the bands move with it.
        requestAnimationFrame(syncBands);
      }
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.current?.remove();
      chart.current = null;
    };
  }, [build, syncBands]);

  return (
    <div className="mh-canvas" style={{ height }}>
      {bands.length > 0
        ? (
          <div className="mh-bands" style={{ right: inset }} aria-hidden="true">
            {bands.map((b) => (
              <div
                key={b.key}
                className={`mh-band r-${b.key}`}
                style={{ top: b.top, height: b.height }}
              >
                {/* The name only when the band is tall enough to hold it. A 9px band with a 9px
                    label in it is two overlapping marks, and the legend under the panel names
                    every band that occurred anyway. */}
                {b.height >= 16 ? <span className="mh-band-l">{b.label}</span> : null}
              </div>
            ))}
          </div>
        )
        : null}
      <div className="mh-plot" ref={box} />
    </div>
  );
}
