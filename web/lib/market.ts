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
export const MARKET_TILES: Array<{
  param: string;
  label: string;
  digits: number;
  signed: boolean;
  suffix: string;
  hint: string;
}> = [
  { param: "vix", label: "VIX", digits: 2, signed: false, suffix: "",
    hint: "16–30 is the band we hedge in; above it is where scaling out gets considered." },
  { param: "term_structure", label: "VIX term structure", digits: 1, signed: true, suffix: "%",
    hint: "3-month VIX over spot. Negative is backwardation — the market pricing near-term stress." },
  { param: "spx_close", label: "S&P 500", digits: 2, signed: false, suffix: "",
    hint: "The base every relative-strength number on the grid is measured against." },
  { param: "breadth_pct", label: "Breadth", digits: 0, signed: false, suffix: "%",
    hint: "Share of the 43 COMPANIES above their own 50-day average. Funds are excluded — a basket of our own names would count them twice." },
];
