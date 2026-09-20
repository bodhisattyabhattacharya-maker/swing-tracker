/**
 * Sparkline — the eight-quarter trace, as inline SVG.
 *
 * NOT A CHART LIBRARY CALL. Lightweight Charts draws the price panel and the market history, and
 * it is the right tool there: axes, crosshair, time scale, thousands of bars. This is eight rects
 * in a 54×16 box with no axis and no interaction, one per cell, potentially 53 of them on screen
 * at once. A canvas stack each would be absurd; the whole thing is one SVG element.
 *
 * NEUTRAL INK, ALWAYS. This is the rule the spec is most explicit about and the easiest to break:
 * a trace is a shape, not a verdict. Colouring a falling series red would make it a judgement the
 * product does not make, and it would collide with the cell's own state colour, which IS a
 * judgement. The only mark is the newest quarter, drawn in full ink while the other seven are
 * muted — position, not hue.
 *
 * IT CANNOT RENDER TODAY, AND THAT IS DELIBERATE, NOT AN OVERSIGHT. Both sparkline columns are
 * `planned`, and both callers test `planned` before they test the render kind, so every one of
 * these cells shows the planned dash until the financials ingest lands (Stage F).
 * `scripts/ci/check_render_kinds.sh` asserts that every kind in the `Render` union is handled by
 * both callers and reports which are reachable today, so the day those columns go live this stops
 * being unreachable and nothing has to remember to wire it.
 */

import { type Point, trace, traceLabel } from "../lib/sparkline";

export const SPARK_W = 54;
export const SPARK_H = 16;

export default function Sparkline(
  { values, width = SPARK_W, height = SPARK_H, label }: {
    values: Point[];
    width?: number;
    height?: number;
    /** Prefixed to the title, e.g. the metric name, so hovering says what the shape is of. */
    label?: string;
  },
) {
  const t = trace(values, width, height);
  // No quarters at all is the cell's own empty state, not a blank box pretending to be a chart.
  if (t.drawn === 0) return <span className="dash">—</span>;

  const title = label ? `${label} — ${traceLabel(t)}` : traceLabel(t);
  return (
    <svg
      className="spark"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      {t.bars.map((b) => (
        <rect
          key={b.i}
          x={b.x}
          y={b.y}
          width={b.w}
          height={b.h}
          rx={0.5}
          className={b.last ? "spark-b last" : "spark-b"}
        />
      ))}
      {/* Drawn only when the series actually crosses zero — see lib/sparkline.ts. Over the bars,
          because the crossing is the thing worth seeing and a rule under them is invisible. */}
      {t.zeroY !== null
        ? <line className="spark-zero" x1={0} y1={t.zeroY} x2={width} y2={t.zeroY} />
        : null}
      {/* A reserved slot with no bar simply leaves a gap, which is correct: a quarter the company
          did not report is not a zero. No element is emitted for it. */}
    </svg>
  );
}
