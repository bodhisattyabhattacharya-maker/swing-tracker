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
  regimeCounts,
  regimeOf,
  spanLabel,
  VIX_BAND,
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
                <p className="note mh-note">
                  {counts.inside} sessions inside the VIX band, {counts.below} below it,{" "}
                  {counts.above} above.
                  {counts.unknown > 0
                    ? ` ${counts.unknown} with no VIX publication, drawn as gaps rather than joined up.`
                    : ""}{" "}
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
      // FULL-SATURATION TONES, NOT THE -bg TINTS, and this was a correction made on screen.
      //
      // The first version used --below-bg for "below" and --rule-soft for "inside". Both are
      // near-white by design - they are cell backgrounds, meant to sit behind dark text - so on a
      // white surface a strip of 91 inside sessions and 33 below sessions was indistinguishable
      // from the panel itself. Only the 2 "above" sessions were visible, and a chart built to show
      // three regimes showed one. A tint that works as a background does not work as a mark.
      // THE INTENSITY SCALE, NOT THE VERDICT ONE. This strip is the VIX tile's colouring in
      // timeline form, and it moved off red/green on 2026-09-20 for the reason recorded above
      // MARKET_TILES in lib/market.ts: with verdicts at muted red and green, "below the band" is a
      // calm tape and would have painted red, "above" a stressed one painting green. Slate for calm,
      // amber for stressed; the middle stays the neutral rule colour it always was.
      const colourFor = (r: MarketRow) => {
        switch (regimeOf(r.vix)) {
          case "below":
            return theme.calm;
          case "above":
            return theme.stress;
          case "inside":
            return theme.rule;
          default:
            // A session with no VIX publication. Transparent, so the gap is a gap - the same rule
            // the line charts follow by skipping the point rather than bridging it.
            return "rgba(0,0,0,0)";
        }
      };
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
      // An area anchored at zero. Contango and backwardation are not "more" and "less" of one
      // thing - they are two states - so the crossing is the feature and zero is where it belongs.
      const term = c.addSeries(AreaSeries, {
        lineColor: theme.ink,
        topColor: theme.aboveBg,
        bottomColor: theme.belowBg,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      term.setData(points(rows, "term_structure"));
      term.createPriceLine({
        price: 0,
        color: theme.inkFaint,
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: "0",
      });
    }

    if (kind === "breadth") {
      // TWO SCALES, because these are two units: a percentage of our own watchlist and an index
      // level. Forcing them onto one axis would make the shapes comparable and the values nonsense.
      const breadth = c.addSeries(LineSeries, {
        color: theme.accent,
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
  }, [kind, rows, theme, height]);

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
      if (w > 0) c.applyOptions({ width: w });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.current?.remove();
      chart.current = null;
    };
  }, [build]);

  return <div className="mh-canvas" ref={box} style={{ height }} />;
}
