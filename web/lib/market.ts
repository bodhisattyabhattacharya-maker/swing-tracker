/**
 * market.ts — the market block's four tiles.
 *
 * Pure configuration, like `columns.ts` and for the same reason: it describes what to render, not
 * how to fetch it, so it can be imported anywhere without dragging the service_role key along.
 *
 * `suffix` rather than a unit column because these are read at a glance and "12.7%" is one token
 * where "12.7" under a "%" heading is two. `hint` is the one-line reason the number is on the page
 * at all — the block is small enough that explaining it costs nothing, and large enough that a
 * reader who has not thought about term structure in a year needs it.
 */
/**
 * WHY A TILE DECLARES ITS SCALE (2026-09-20, decision 0052)
 *
 * Every other judged thing in this product is a security against a norm, where "below the band" and
 * "above the band" are two equally interesting directions and the verdict palette — muted red and
 * green — says which one without saying whether it is good.
 *
 * VIX is not that. Its band is 16–30, so under the same mapping a calm tape at 14 paints red and a
 * stressed tape at 34 paints green, which is backwards to anyone who has ever looked at a
 * volatility chart. The number and the band are printed on the tile either way, but a green tile
 * during a stress event is a thing the eye reads before the text and gets wrong.
 *
 * The fix is not to invert VIX — an exception inside one mapping is how a palette stops meaning
 * anything. It is to say that VIX is on a DIFFERENT SCALE: an intensity, calm to stressed, in its
 * own two colours (slate and amber) that appear nowhere else. Red and green then keep exactly one
 * meaning across the whole product, and the market's temperature is not borrowing a security's
 * vocabulary to express itself.
 *
 * Term structure stays on the verdict scale and is correct there: below zero is backwardation, and
 * backwardation in red is what it should be.
 */
export type TileScale = "verdict" | "intensity";

export const MARKET_TILES: Array<{
  param: string;
  label: string;
  digits: number;
  signed: boolean;
  suffix: string;
  hint: string;
  /** Omitted means "verdict" — the ordinary red/green pair every security metric uses. */
  scale?: TileScale;
  /**
   * The line under the value: what this number IS, in three or four words.
   *
   * Two forms, because two kinds of tile. `states` names each side of the norm, so the reader is
   * told which side this value fell on without decoding the colour — the spec asks for exactly
   * that, and it is also what makes the tile legible in greyscale. `note` is a fixed phrase for a
   * tile with no norm, where there is no side to be on and the useful thing to say is what the
   * number measures.
   */
  states?: { below: string; normal: string; above: string };
  note?: string;
}> = [
  { param: "vix", label: "VIX", digits: 2, signed: false, suffix: "", scale: "intensity",
    states: { below: "calm · below band", normal: "in band", above: "stressed · above band" },
    hint: "16–30 is the band we hedge in; above it is where scaling out gets considered." },
  { param: "term_structure", label: "VIX term structure", digits: 1, signed: true, suffix: "%",
    states: { below: "backwardation", normal: "contango", above: "contango" },
    hint: "3-month VIX over spot. Negative is backwardation — the market pricing near-term stress." },
  { param: "spx_close", label: "S&P 500", digits: 2, signed: false, suffix: "",
    note: "the relative-strength base",
    hint: "The base every relative-strength number on the grid is measured against." },
  { param: "breadth_pct", label: "Breadth", digits: 0, signed: false, suffix: "%",
    note: "above own SMA200",
    hint: "Share of the ELIGIBLE companies above their own 200-day average — eligible meaning it has 200 bars, which is fewer than the 43 we track for a newly listed name. Funds are excluded; a basket of our own names would count them twice." },
];
