"use client";

/**
 * StockChart — one security's price panel inside its Deep Dive column.
 *
 * A CLIENT COMPONENT THAT FETCHES, the second one in the app. It goes through
 * `/api/stock-history`, which holds the credential; this file imports only pure modules and never
 * sees one. `check_web_boundary.sh` fails the build if it ever reaches `lib/grid.ts`.
 *
 * ---------------------------------------------------------------------------
 * IT DOES NOT FETCH UNTIL YOU SCROLL TO IT
 *
 * The strip is 53 columns and 22,260px wide. Mounting 53 charts on load would be 53 requests and 53
 * canvas stacks for a screen that shows four of them — which is the whole reason the bars are not
 * in the page payload in the first place (decision 0049). An IntersectionObserver with a margin
 * starts the read shortly before a column arrives, so the chart is usually there by the time it is.
 * A column you never scroll to costs nothing at all.
 *
 * ---------------------------------------------------------------------------
 * THE MARK FOLLOWS THE DENSITY (Bodhi, 2026-09-19)
 *
 * Candles while each candle has room to be one, a line once it does not. Both series are built once
 * and their visibility is swapped when the range changes — not rebuilt. The threshold is pixels per
 * bar rather than a bar count, so it stays true if a column is ever a different width.
 * `lib/stock-history.ts` holds the rule, and its RANGES comment records why this is three buttons
 * rather than a pan: panning moves the window but never widens it, so the line could not be reached
 * at all, and a drag inside a horizontally scrolling strip is ambiguous about what it is dragging.
 * One request serves all three ranges.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT REFUSES TO DO
 *
 *   - It does not draw axes while loading. An empty frame reads as "this name has no price
 *     history", which is a claim about the data rather than about the request.
 *   - It does not bridge a gap in an overlay. A bar inside an average's warm-up has no average, and
 *     a carried value would draw a flat stretch that never happened.
 *   - It does not draw the week in progress. See `BARS.w.filter` for why that is not tidiness.
 *   - It does not carry its own palette. Colours are read off the page, so a chart cannot disagree
 *     with the cell beside it and both themes work without a second set of literals.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  type IChartApi,
  type ISeriesApi,
  LineSeries,
  createChart,
} from "lightweight-charts";
import { baseChartOptions, type ChartTheme, readTheme, watchTheme } from "../lib/chart-theme";
import {
  barsInRange,
  type Mark,
  markFor,
  OVERLAYS,
  type RangeSpec,
  RANGES,
  type Series,
  seriesUrl,
  rangeLabel,
  type Timeframe,
  TIMEFRAME_LABEL,
  TIMEFRAMES,
} from "../lib/stock-history";

/** Same height as the VIX chart on the Dashboard, so the two read as one product. */
export const CHART_HEIGHT = 200;

type Load =
  | { s: "idle" }
  | { s: "loading" }
  | { s: "error"; message: string }
  | { s: "ready"; series: Series };

export default function StockChart({ symbol }: { symbol: string }) {
  const [tf, setTf] = useState<Timeframe>("d");
  const [rangeKey, setRangeKey] = useState<string>(RANGES.d[0].key);
  const [load, setLoad] = useState<Load>({ s: "idle" });
  const [theme, setTheme] = useState<ChartTheme | null>(null);
  const [mark, setMark] = useState<Mark>("candles");
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTheme(readTheme());
    return watchTheme(setTheme);
  }, []);

  // Seen once, then the observer is done: a column that has been read does not need watching, and
  // 53 live observers on a long scroll is work for nothing.
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = host.current;
    if (!el || seen) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      // Start the read about one column early, so the chart is usually painted by arrival.
      { root: el.closest(".dd-scroll") ?? null, rootMargin: "0px 480px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);

  useEffect(() => {
    if (!seen) return;
    const ac = new AbortController();
    setLoad({ s: "loading" });
    fetch(seriesUrl(symbol, tf), { signal: ac.signal })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
        setLoad({ s: "ready", series: body as Series });
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        setLoad({ s: "error", message: e instanceof Error ? e.message : String(e) });
      });
    return () => ac.abort();
  }, [seen, symbol, tf]);

  // The ranges are per timeframe, so switching D/W resets to that timeframe's shortest view rather
  // than keeping a key that means nothing on the other side ("3M" does not exist in weeks).
  const ranges = RANGES[tf];
  const range: RangeSpec = ranges.find((r) => r.key === rangeKey) ?? ranges[0];
  // Null until the read lands. Until then every key is drawn plain rather than struck: "we do not
  // know yet" must not look like "this one is missing".
  const series = load.s === "ready" ? load.series : null;

  const controls = (
    <div className="pc-head">
      <div className="pc-tf" role="tablist" aria-label="Timeframe">
        {TIMEFRAMES.map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={tf === k}
            className={tf === k ? "seg on" : "seg"}
            onClick={() => {
              setTf(k);
              setRangeKey(RANGES[k][0].key);
            }}
          >
            {k.toUpperCase()}
          </button>
        ))}
      </div>
      <div className="pc-range" role="tablist" aria-label="Range">
        {ranges.map((r) => (
          <button
            key={r.key}
            role="tab"
            aria-selected={range.key === r.key}
            className={range.key === r.key ? "seg on" : "seg"}
            onClick={() => setRangeKey(r.key)}
          >
            {r.label}
          </button>
        ))}
      </div>
      {/* A KEY IS DIMMED WHEN ITS LINE IS NOT THERE, rather than dropped or left claiming a line.
          Found by checking the deployed route against the database on 2026-09-19: ALAB has 130
          completed weeks, a 200-week average needs 200, so `sma200w` comes back as an empty array
          and nothing is drawn — while the legend went on listing SMA200W. ARM and SNDK are the
          same. Dropping the key would be worse than leaving it: three names would have a
          two-entry legend and no reason given. Struck through, with the reason on hover, says the
          line is missing AND why. */}
      <span className="pc-legend">
        {OVERLAYS[tf].map((o, i) => {
          const drawn = !series || (series.overlays[o.key]?.length ?? 0) > 0;
          return (
            <span
              key={o.key}
              className={drawn ? `pc-key k${i}` : `pc-key k${i} off`}
              title={drawn ? undefined : `${symbol} has too little history for ${o.label}, so it is not drawn`}
            >
              {o.label}
            </span>
          );
        })}
      </span>
    </div>
  );

  return (
    <div className="pc" ref={host}>
      {controls}

      {load.s === "idle" || load.s === "loading"
        ? (
          <p className="note pc-note">
            {load.s === "idle"
              ? "Scroll to this column to read its bars."
              : `Reading ${TIMEFRAME_LABEL[tf].toLowerCase()} bars for ${symbol}…`}
          </p>
        )
        : load.s === "error"
        ? (
          <p className="note pc-note">
            <b>The price series could not be read.</b> Everything else in this column came with the
            page and is unaffected. <span className="err">{load.message}</span>
          </p>
        )
        : load.series.bars.length === 0
        ? (
          <p className="note pc-note">
            No {tf === "d" ? "sessions" : "completed weeks"} stored for {symbol}. The request
            succeeded and returned nothing, which is not the same as a failed read.
          </p>
        )
        : theme
        ? (
          <>
            <Plot series={load.series} theme={theme} range={range} onMark={setMark} />
            <p className="note pc-note">
              {rangeLabel(load.series.tf, range, load.series.bars)} ·{" "}
              {mark === "candles"
                ? "candles"
                : "line, too dense for candles"}
              {load.series.tf === "w" ? " · completed weeks only" : ""}
            </p>
          </>
        )
        : <div className="pc-hold" style={{ height: CHART_HEIGHT }} />}
    </div>
  );
}

/**
 * The chart itself. Built once per (series, theme); panning only changes which series is visible.
 */
function Plot(
  { series, theme, range, onMark }: {
    series: Series;
    theme: ChartTheme;
    range: RangeSpec;
    onMark: (m: Mark) => void;
  },
) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const line = useRef<ISeriesApi<"Line"> | null>(null);

  const build = useCallback(() => {
    const el = box.current;
    if (!el) return;
    const w = el.clientWidth;
    if (w === 0) return;

    chart.current?.remove();
    const c = createChart(el, {
      ...baseChartOptions(theme),
      width: w,
      height: CHART_HEIGHT,
      // LOCKED, like every other chart in this app. The range buttons are the control; a drag
      // inside a horizontally scrolling strip is ambiguous about what it moves, and a wheel inside
      // one is a fight over the gesture. See RANGES in lib/stock-history.ts for the version of this
      // panel that could be panned, and the two measurements that ended it.
      handleScroll: false,
      handleScale: false,
    });
    chart.current = c;

    // Both marks, same data, built once. Visibility is the only thing that changes on a pan.
    const cs = c.addSeries(CandlestickSeries, {
      upColor: theme.surface,
      downColor: theme.ink,
      borderUpColor: theme.ink,
      borderDownColor: theme.ink,
      wickUpColor: theme.ink,
      wickDownColor: theme.ink,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    cs.setData(series.bars);
    candles.current = cs;

    const ln = c.addSeries(LineSeries, {
      color: theme.ink,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      visible: false,
    });
    ln.setData(series.bars.map((b) => ({ time: b.time, value: b.close })));
    line.current = ln;

    // The averages, always drawn, always full width. Sparse by construction — `stitch` omits a bar
    // whose average does not exist yet rather than carrying the previous one forward.
    // THE OVERLAY HUES, NOT THE VERDICT ONES. This array used to be [accent, below, above], which
    // was fine while those were teal, blue and ochre; with verdicts now muted red and green
    // (decision 0052) it would have drawn the 50-day average in the colour that means "below its
    // norm" everywhere else on the page. Order must match .pc-key.k0/k1/k2 in app/layout.tsx, which
    // is what the legend beside this canvas is coloured from.
    const colours = [theme.ma1, theme.ma2, theme.ma3];
    OVERLAYS[series.tf].forEach((spec, i) => {
      const pts = series.overlays[spec.key] ?? [];
      if (pts.length === 0) return;
      const s = c.addSeries(LineSeries, {
        color: colours[i % colours.length],
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      s.setData(pts);
    });

    // The chosen range, counted back from the newest bar. One request holds every range, so this
    // is the only thing a button press changes.
    const n = series.bars.length;
    const shown = barsInRange(range, n);
    c.timeScale().setVisibleLogicalRange({ from: n - shown, to: n - 1 });

    // The mark, decided once per range from the bars actually in view and the measured plot width.
    const m = markFor(shown, w);
    candles.current?.applyOptions({ visible: m === "candles" });
    line.current?.applyOptions({ visible: m === "line" });
    onMark(m);
  }, [series, theme, range, onMark]);

  useEffect(() => {
    build();
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const c = chart.current;
      const w = el.clientWidth;
      if (!c) {
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
      candles.current = null;
      line.current = null;
    };
  }, [build]);

  return <div className="pc-canvas" ref={box} style={{ height: CHART_HEIGHT }} />;
}
