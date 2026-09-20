/**
 * sparkline.ts — the geometry of the eight-quarter trace, and nothing else.
 *
 * PURE, like `columns.ts` and for the same reason: client components import it, so it may never
 * see a fetch, an env var or a secret. `scripts/ci/check_web_boundary.sh` fails the build otherwise.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A MODULE AND NOT TWELVE LINES INSIDE A COMPONENT
 *
 * The same trace is drawn in two places — a grid cell and a Deep Dive strip row — and the two are
 * different elements at different sizes. A copy in each is how the strip and the grid ended up
 * disagreeing about cell colour in September, which took a CI check to find. One function, two
 * callers.
 *
 * It is also the only part of this that can be VERIFIED TODAY. Both sparkline columns are
 * `planned`, and `Cell` tests `planned` before it tests the render kind, so the trace cannot appear
 * on the page until the Massive add-on lands (Stage F). What can be exercised now is the
 * arithmetic — and the arithmetic is where the bodies are: an empty series, one point, a flat
 * series whose range is zero, a series that crosses zero, a series with holes in it.
 *
 * ---------------------------------------------------------------------------
 * THE BASELINE IS ZERO, NOT THE MINIMUM
 *
 * Scaling from min to max makes every series fill the box, which is flattering and wrong: a
 * company whose revenue moved 2% over eight quarters would draw the same dramatic staircase as one
 * that tripled. The column's own hint says the shape is the point rather than the magnitude, and
 * that is about the TOP of the scale being per-security — not about inventing a floor. Bars start
 * at zero, or at the series minimum when the series goes negative, and then a zero rule is drawn
 * so the crossing is visible.
 *
 * ---------------------------------------------------------------------------
 * A HOLE IS NOT A ZERO
 *
 * A quarter a company did not report comes through as `null` and is drawn as nothing — no bar, and
 * the slot is still reserved so the cadence stays even and quarter five is in the same place on
 * every row. Drawing it as a zero-height bar would say the company earned nothing that quarter.
 * This is the same rule the price overlays follow by skipping a bar inside an average's warm-up.
 */

/** One quarter. `null` where the company did not report — see the header. */
export type Point = number | null | undefined;

/** A drawable bar, in the SVG user space the caller set up. */
export interface Bar {
  /** Index in the input series, so a caller can label or key by quarter. */
  i: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** True for the newest quarter, which is marked. */
  last: boolean;
  /** True when the value is below the baseline. */
  negative: boolean;
}

export interface Trace {
  bars: Bar[];
  /** The y of the zero line in user space, or null when the series never crosses it. */
  zeroY: number | null;
  /** How many slots were reserved, including the ones with no bar. */
  slots: number;
  /** How many of those actually carry a value. */
  drawn: number;
}

/** Gap between bars, in the same user space. Small: eight bars in ~54px leaves little to spend. */
export const BAR_GAP = 1.5;
/** Nothing is drawn thinner than this; below it the trace is a smudge and says nothing. */
export const MIN_BAR_W = 1;
/** A bar at exactly the baseline still gets this much height, so "reported, and it was zero" is
 *  visibly different from "did not report", which draws nothing at all. */
export const MIN_BAR_H = 1;

function finite(v: Point): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Lay out an eight-quarter trace inside a box.
 *
 * Returns an empty trace rather than throwing when there is nothing to draw: a security with no
 * reported quarters is an ordinary state, and the caller renders the cell's own empty treatment.
 */
export function trace(values: Point[], width: number, height: number): Trace {
  const slots = values.length;
  const out: Trace = { bars: [], zeroY: null, slots, drawn: 0 };
  if (slots === 0 || !(width > 0) || !(height > 0)) return out;

  const nums = values.filter(finite);
  out.drawn = nums.length;
  if (nums.length === 0) return out;

  // THE SCALE ALWAYS CONTAINS ZERO, at both ends. Taking the floor at min(0, min) but leaving the
  // top at max(values) looks right and is not: for an all-negative series the range runs from the
  // most negative value up to the least negative one, so zero sits ABOVE the top of the box and
  // every bar is drawn hanging off it, outside the frame. Measured, not reasoned — the eight-bar
  // all-negative case in the harness produced y = -2.29 with h = 18.29 in a 16px box.
  const floor = Math.min(0, ...nums);
  const ceil = Math.max(0, ...nums);
  // A series of nothing but zeros has no range at all. Give it one, so the arithmetic below yields
  // a number instead of NaN — a NaN rect renders as nothing, which on this page reads as a quarter
  // that was never reported.
  const span = ceil - floor || 1;

  const w = Math.max(MIN_BAR_W, (width - BAR_GAP * (slots - 1)) / slots);
  const baseY = height - ((0 - floor) / span) * height;
  // Only drawn when the series actually goes below zero. A series entirely at or above it has its
  // baseline AT zero already, and a rule along the feet of the bars says nothing.
  out.zeroY = floor < 0 ? baseY : null;

  values.forEach((v, i) => {
    if (!finite(v)) return;
    const x = i * (w + BAR_GAP);
    const vy = height - ((v - floor) / span) * height;
    // THE MINIMUM HEIGHT HAS A DIRECTION. Clamping the height alone and then placing the bar at
    // min(vy, baseY) puts a zero-height bar BELOW the baseline, which for a series sitting on the
    // floor of the box means one pixel outside it. A bar at or above zero grows upward from the
    // baseline; a negative one grows down from it.
    const h = Math.max(MIN_BAR_H, Math.abs(baseY - vy));
    const up = v >= 0;
    const y = Math.min(Math.max(up ? baseY - h : baseY, 0), height - h);
    out.bars.push({ i, x, y, w, h, last: i === slots - 1, negative: v < 0 });
  });
  return out;
}

/** How many quarters the spec's trace shows. Named so a caller cannot quietly draw a different number. */
export const QUARTERS = 8;

/**
 * The one-line description under the trace, or in its title attribute.
 *
 * Spelled out here rather than in the component because it states a fact about the DATA — how many
 * of the eight quarters were reported — and that fact is the difference between a short trace and
 * a broken one.
 */
export function traceLabel(t: Trace): string {
  if (t.drawn === 0) return "no quarters reported";
  if (t.drawn === t.slots) return `${t.slots} quarters, newest at the right`;
  return `${t.drawn} of ${t.slots} quarters reported, newest at the right`;
}
