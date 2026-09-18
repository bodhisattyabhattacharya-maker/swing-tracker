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
 * `config/norms.yml`, the same numbers that colour the VIX tile above. The other three are context
 * and carry no verdict, which is why none of them draws a threshold line — a line on a chart reads
 * as a rule, and inventing one here would be inventing a norm.
 */
export const CHARTS: ChartSpec[] = [
  {
    key: "vix",
    title: "VIX",
    sub: "Daily close with its 20-bar average. Shaded band is the norm we set.",
    height: 200,
    band: "16 · 30",
  },
  {
    key: "regime",
    title: "Regime",
    sub: "Which side of the VIX band each session closed on.",
    // No time axis of its own - see MarketHistory. 46px is the strip plus its caption gap.
    height: 46,
  },
  {
    key: "term",
    title: "VIX term structure",
    sub: "3-month VIX over spot, as a percentage. Below zero is backwardation.",
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

export type Regime = "below" | "inside" | "above" | "unknown";

/**
 * Which side of the norm band a session closed on.
 *
 * Derived from the VALUE and `VIX_BAND`, not from `market_context.vix_band` — that column is a text
 * label built for the digest ("16-30") and parsing a label to recover the numbers it was rendered
 * from is how a display string becomes an accidental API. The band is right here.
 */
export function regimeOf(vix: number | null | undefined): Regime {
  if (typeof vix !== "number") return "unknown";
  if (vix < VIX_BAND.low) return "below";
  if (vix > VIX_BAND.high) return "above";
  return "inside";
}

/** How many sessions in each regime, for the line under the timeline. */
export function regimeCounts(rows: MarketRow[]): Record<Regime, number> {
  const c: Record<Regime, number> = { below: 0, inside: 0, above: 0, unknown: 0 };
  for (const r of rows) c[regimeOf(r.vix)]++;
  return c;
}

/** "2026-03-20 → 2026-09-17 · 126 sessions", or a plain statement that there is nothing to draw. */
export function spanLabel(rows: MarketRow[]): string {
  const dates = rows.map((r) => r.d).filter((x): x is string => !!x);
  if (dates.length === 0) return "no sessions";
  const n = dates.length;
  return `${dates[0]} → ${dates[n - 1]} · ${n} session${n === 1 ? "" : "s"}`;
}
