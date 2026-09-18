"use client";

/**
 * CellHistoryChart — one parameter's history for one security, inside the cell detail sheet.
 *
 * A CLIENT COMPONENT that fetches. The only one in the app: everything else reads at render time on
 * the server. It goes through `/api/cell-history`, which holds the credential; this file never sees
 * one and imports only pure modules.
 *
 * WHAT IT REFUSES TO DO:
 *   - It does not draw a chart while loading. A frame with axes and no line reads as "this cell has
 *     no history", which is a claim about the data rather than about the request.
 *   - It does not bridge a gap. A null in the middle of a series is a session with no valid value,
 *     and joining across it would draw a line through a day that had none.
 *   - It does not draw a band for a parameter with no norm. Grey means we have no opinion; a band
 *     would invent one.
 *   - It does not colour the line by verdict. The line is the value over five years; a verdict is
 *     about today. Colouring history by today's threshold would restate the norm as a fact about
 *     the past, which it is not - norms get retuned (decision 0038).
 */

import { useEffect, useRef, useState } from "react";
import { type IChartApi, LineSeries, LineStyle, createChart } from "lightweight-charts";
import { baseChartOptions, type ChartTheme, readTheme, watchTheme } from "../lib/chart-theme";
import { describe, type HistoryPoint, historyUrl } from "../lib/cell-history";

type Load =
  | { s: "loading" }
  | { s: "error"; message: string }
  | { s: "ready"; points: HistoryPoint[] };

export default function CellHistoryChart(
  { symbol, param, digits, suffix, norm }: {
    symbol: string;
    param: string;
    digits: number;
    suffix?: string;
    norm?: { low: number | null; high: number | null };
  },
) {
  const [load, setLoad] = useState<Load>({ s: "loading" });
  const [theme, setTheme] = useState<ChartTheme | null>(null);

  useEffect(() => {
    setTheme(readTheme());
    return watchTheme(setTheme);
  }, []);

  useEffect(() => {
    // Aborted on unmount, because the sheet closes faster than a cold read returns and a setState
    // after that is a warning at best and a leak at worst.
    const ac = new AbortController();
    setLoad({ s: "loading" });
    fetch(historyUrl(symbol, param), { signal: ac.signal })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
        setLoad({ s: "ready", points: Array.isArray(body.points) ? body.points : [] });
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        setLoad({ s: "error", message: e instanceof Error ? e.message : String(e) });
      });
    return () => ac.abort();
  }, [symbol, param]);

  if (load.s === "loading") {
    return <p className="note hist-note">Reading five years of {param}…</p>;
  }
  if (load.s === "error") {
    return (
      <p className="note hist-note">
        <b>The history could not be read.</b> The value above is unaffected — it came with the page.{" "}
        <span className="err">{load.message}</span>
      </p>
    );
  }
  if (load.points.length === 0) {
    return (
      <p className="note hist-note">
        No history rows for this parameter on this security. That is not the same as a failed read:
        the request succeeded and returned nothing.
      </p>
    );
  }

  return (
    <>
      {theme
        ? <Line points={load.points} theme={theme} norm={norm} digits={digits} />
        : <div className="hist-hold" />}
      <p className="note hist-note">
        {describe(load.points)}
        {suffix ? ` · values in ${suffix === "%" ? "percent" : suffix}` : ""}
      </p>
    </>
  );
}

function Line(
  { points, theme, norm, digits }: {
    points: HistoryPoint[];
    theme: ChartTheme;
    norm?: { low: number | null; high: number | null };
    digits: number;
  },
) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el || el.clientWidth === 0) return;
    chart.current?.remove();
    const c = createChart(el, {
      ...baseChartOptions(theme),
      width: el.clientWidth,
      height: 150,
      localization: { priceFormatter: (v: number) => v.toFixed(digits) },
    });
    chart.current = c;

    const s = c.addSeries(LineSeries, {
      color: theme.ink,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    // Nulls are dropped rather than bridged. lightweight-charts would happily connect across them.
    s.setData(
      points
        .filter((p) => typeof p.value === "number")
        .map((p) => ({ time: p.d, value: p.value as number })),
    );

    // The norm band, only when there is one, and only for the bound that exists - several norms in
    // config/norms.yml are one-sided and drawing a phantom line at the missing end would invent a
    // threshold.
    for (const bound of [norm?.low, norm?.high]) {
      if (typeof bound !== "number") continue;
      s.createPriceLine({
        price: bound,
        color: theme.rule,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "",
      });
    }

    c.timeScale().fitContent();
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (chart.current && w > 0) chart.current.applyOptions({ width: w });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.current?.remove();
      chart.current = null;
    };
  }, [points, theme, norm, digits]);

  return <div className="hist-canvas" ref={box} />;
}
