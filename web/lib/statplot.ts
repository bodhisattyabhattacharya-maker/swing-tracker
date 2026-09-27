/**
 * statplot.ts — where a price statistic sits on its own natural range.
 *
 * PURE, with no runtime imports, for the reason `lib/selection.ts` gives: `deep-dive.ts` imports
 * `./columns` without an extension, which a bundler resolves and a plain `node` does not, so a
 * check that wants to exercise the real arithmetic cannot load anything that reaches it.
 *
 * ---------------------------------------------------------------------------
 * WHAT A TRACK IS, AND WHAT IT IS NOT
 *
 * A thin rule with a marker on it, under a number that is already printed. It answers one
 * question the number alone answers badly: **is this reading near the edge of what this quantity
 * does, or in the middle of it?** −9.6% off a 52-week high is unremarkable; −46% is most of the
 * way to the worst this statistic gets. Both are just numbers until something shows the span.
 *
 * It is NOT a verdict, and the distinction is the same one the regime scale draws. Where a norm
 * exists the track carries a NOTCH at the bound, which is the only mark on it that means the
 * product has an opinion. The ends of the track are display constants and mean nothing except
 * "this is the range we draw over" — retuning one changes no cell's colour anywhere.
 *
 * ---------------------------------------------------------------------------
 * THE SPANS ARE MEASURED, NOT CHOSEN
 *
 * Taken from the live watchlist on 2026-09-27, across every security with a value:
 *
 *   pct_off_52w_high      −46.1 .. −3.5      span −50 .. 0
 *   pct_off_high_stored   −68.2 .. −3.5      span −80 .. 0     (diverges from the 52w figure on
 *                                                               names that peaked years ago)
 *   realized_vol_20        20.3 .. 61.2      span   0 .. 100
 *   volume_ratio            0.5 .. 1.6       span   0 .. 3     (notch at 1.0 — see below)
 *   pct_above_low_stored  119.9 .. 5350.9    NO TRACK
 *
 * `pct_above_low_stored` gets no track and that is the measurement's doing, not an oversight. It
 * spans 120% to 5,350% — a factor of 45 — and there is no linear scale on which both ends say
 * anything: put 5,350 at the right edge and every other name is a tick in the first 2% of the
 * rule. A log scale would fix the spread and break the row, because a marker halfway along one
 * track would then mean something different from a marker halfway along the four beside it. Same
 * reasoning as `close_vs_sma200w` being left uncoloured: a mark that cannot discriminate is worse
 * than no mark, because it looks like it discriminates.
 *
 * ---------------------------------------------------------------------------
 * 1.0 ON THE VOLUME TRACK IS A DEFINITION, NOT A NORM
 *
 * `volume_ratio` is today's volume over its own 50-day average, so 1.0 is "an ordinary day for
 * this name" by construction — the same kind of fact as zero on the term-structure chart. It is
 * drawn as a notch, and `config/norms.yml` sets no bound for this parameter and does not need to.
 */

/** A stat's drawable range. `null` spans mean the stat is deliberately not tracked. */
export interface TrackSpec {
  param: string;
  lo: number;
  hi: number;
  /**
   * A reference line that is TRUE BY CONSTRUCTION rather than chosen — 1.0 on a ratio against its
   * own average. Distinct from a norm bound, which arrives separately and is the product's
   * opinion.
   */
  definitionAt?: number;
}

export const TRACKS: TrackSpec[] = [
  { param: "pct_off_52w_high", lo: -50, hi: 0 },
  { param: "pct_off_high_stored", lo: -80, hi: 0 },
  { param: "realized_vol_20", lo: 0, hi: 100 },
  { param: "volume_ratio", lo: 0, hi: 3, definitionAt: 1 },
];

/**
 * Params that a track is deliberately withheld from, with the reason, so the absence is a
 * recorded decision rather than a gap someone fills in later without measuring.
 */
export const UNTRACKED: ReadonlyMap<string, string> = new Map([
  [
    "pct_above_low_stored",
    "measured at 120% to 5,350% across the watchlist — no linear scale shows both ends, and a log "
    + "one would mean something different from the tracks beside it",
  ],
]);

export interface Track {
  /** 0..1, where the marker goes. Already clamped. */
  at: number;
  /** True when the value fell outside the span and the marker is sitting on an edge. */
  clamped: boolean;
  /** 0..1 for a norm bound inside the span, or null. The one mark that carries an opinion. */
  normAt: number | null;
  /** 0..1 for a by-construction reference such as 1.0 on a ratio, or null. */
  defAt: number | null;
  lo: number;
  hi: number;
}

const frac = (v: number, lo: number, hi: number) => (v - lo) / (hi - lo);
const clamp01 = (x: number) => Math.min(Math.max(x, 0), 1);

/**
 * Place a value, and optionally its norm bound, on a track.
 *
 * Returns null when there is no track for this param, when the value is not a usable number, or
 * when the span is degenerate. A caller that gets null draws the number alone — which is what
 * every one of these rows did before, so the fallback is the previous behaviour rather than a
 * hole.
 *
 * A VALUE OUTSIDE THE SPAN IS CLAMPED AND SAID SO, not dropped and not drawn off the end. The
 * spans come from one day's measurement of 53 securities; a new name or a bad month will
 * eventually produce a reading past one of them, and when it does the honest picture is a marker
 * pinned to the edge with something saying it is pinned. Silently drawing at 110% of the width
 * would put a mark outside its own rule.
 */
export function track(
  param: string,
  value: number | null | undefined,
  norm?: { low: number | null; high: number | null },
): Track | null {
  const spec = TRACKS.find((t) => t.param === param);
  if (!spec) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (!(spec.hi > spec.lo)) return null;

  const raw = frac(value, spec.lo, spec.hi);
  const at = clamp01(raw);

  // The norm bound worth drawing is whichever one falls INSIDE the span. These norms are
  // one-sided — `pct_off_52w_high` is `low: -25` with no high — so at most one ever does.
  let normAt: number | null = null;
  for (const bound of [norm?.low, norm?.high]) {
    if (typeof bound !== "number" || !Number.isFinite(bound)) continue;
    const f = frac(bound, spec.lo, spec.hi);
    if (f >= 0 && f <= 1) { normAt = f; break; }
  }

  const defAt = typeof spec.definitionAt === "number"
    ? (() => {
      const f = frac(spec.definitionAt as number, spec.lo, spec.hi);
      return f >= 0 && f <= 1 ? f : null;
    })()
    : null;

  return { at, clamped: raw !== at, normAt, defAt, lo: spec.lo, hi: spec.hi };
}

/** The sentence under a track, for the title attribute. Says the span, and says when it is pinned. */
export function trackLabel(t: Track, suffix = ""): string {
  const span = `${t.lo}${suffix} to ${t.hi}${suffix}`;
  return t.clamped
    ? `outside the drawn range of ${span} — the marker is pinned to the edge`
    : `on a range of ${span}`;
}
