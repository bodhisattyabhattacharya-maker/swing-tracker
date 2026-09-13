/**
 * digest/render.ts — the email's wording, as a pure function.
 *
 * Separate from index.ts for one concrete reason: index.ts calls `Deno.serve` at module top level,
 * so importing anything from it inside a test starts a real HTTP listener and leaks it. The same
 * trap was hit with the ingest function; keeping the renderer here means the wording of an email
 * that gets sent to people is testable without a network, an API key, or any risk of sending.
 *
 * Everything here is pure. No fetch, no env, no clock.
 */

export interface Status {
  data_through: string | null;
  symbols: number | null;
  hours_since_success: number | null;
  stale_after_hours: number | null;
  is_stale: boolean | null;
}

export interface Change {
  symbol: string;
  param: string;
  d: string;
  prev_d: string;
  value: number | null;
  prev_value: number | null;
  prev_verdict: string;
  verdict: string;
  movement: string;
  now_outside: boolean;
}

export interface Standing {
  symbol: string;
  param: string;
  value: number | null;
  verdict: string;
}

/** Column labels, matching the dashboard. A digest that names things differently from the page it
 *  links to makes the reader do a translation step at exactly the wrong moment. */
const LABELS: Record<string, string> = {
  rsi_daily: "RSI 14",
  close_vs_sma200d: "vs 200 SMA",
  close_vs_sma50d: "vs 50 SMA",
  close_vs_ema21d: "vs 21 EMA",
  pct_off_high_stored: "off its high",
  pct_off_52w_high: "off its 52-week high",
  realized_vol_20: "realised vol",
  volume_ratio: "volume ratio",
};

const label = (p: string) => LABELS[p] ?? p;
/**
 * TWO decimals, where the grid shows one. Not an inconsistency — a different job.
 *
 * The grid displays a value; the digest asserts that a value CROSSED something. At one decimal
 * place the assertion can contradict itself on screen: on 2026-09-11 QCOM went to -29.99 against a
 * norm of -30, which rounds to "-30.0 → back inside", and CAT left a -25 norm from -25.0088, which
 * rounds to "-25.0 → was outside". Both verdicts were correct and both lines read as wrong.
 *
 * A reader who doubts one line doubts the whole email, so the digit the claim rests on has to be
 * visible. The grid keeps one decimal because it is a scan of 360 cells where the extra digit is
 * noise rather than evidence.
 */
const num = (v: number | null, digits = 2) => (v === null ? "—" : v.toFixed(digits));

/**
 * Pure: the whole email as plain text. Exported and pure so the wording is testable without a
 * network, an API key, or the risk of actually sending something.
 */
export function renderDigest(
  status: Status,
  changes: Change[],
  standing: Standing[],
  gridUrl: string,
): { subject: string; text: string } {
  // The stale path is first and exclusive. Everything below it would be computed from data we
  // have just said we do not trust.
  if (status.is_stale) {
    const age = status.hours_since_success === null
      ? "has never completed successfully"
      : `last completed ${Math.round(status.hours_since_success)} hours ago`;
    return {
      subject: "Swing Tracker — data is behind, no digest today",
      text: [
        `The daily ingest ${age}.`,
        "",
        "No digest today: anything it said about what crossed a norm would be computed from data",
        "that is not current, and a confident-looking email is the worst way to deliver that.",
        "",
        `Newest bar held: ${status.data_through ?? "none"}.`,
        `Expected to run every weekday evening; threshold is ${status.stale_after_hours ?? "?"} hours.`,
        "",
        `Grid: ${gridUrl}`,
      ].join("\n"),
    };
  }

  const crossed = changes.filter((c) => c.now_outside);
  const settled = changes.filter((c) => !c.now_outside);

  const lines: string[] = [];
  lines.push(`Close of ${status.data_through}. ${status.symbols ?? "?"} names tracked.`);
  lines.push("");

  if (changes.length === 0) {
    // The explicit nothing-happened case. This is the most common outcome and it has to read as a
    // deliberate statement, not as a truncated email.
    lines.push("Nothing crossed a norm today.");
  } else {
    if (crossed.length) {
      lines.push(`MOVED OUTSIDE A NORM (${crossed.length})`);
      for (const c of crossed) {
        lines.push(
          `  ${c.symbol.padEnd(6)} ${label(c.param)} ${num(c.prev_value)} → ${num(c.value)}  ${c.movement}`,
        );
      }
      lines.push("");
    }
    if (settled.length) {
      lines.push(`BACK INSIDE (${settled.length})`);
      for (const c of settled) {
        lines.push(
          `  ${c.symbol.padEnd(6)} ${label(c.param)} ${num(c.prev_value)} → ${num(c.value)}`,
        );
      }
      lines.push("");
    }
  }

  // The standing backdrop. Without it, a name that went 45% below its high three months ago is
  // never mentioned again after the day it happened - the "rally we were never in" miss that
  // motivated the tool (PROPOSAL §1).
  const bySymbol = new Set(standing.map((s) => s.symbol));
  lines.push("");
  lines.push(
    `Still outside a norm: ${standing.length} values across ${bySymbol.size} names.`,
  );
  lines.push("");
  lines.push(`Full grid: ${gridUrl}`);

  const subject = changes.length === 0
    ? `Swing Tracker — nothing crossed, ${status.data_through}`
    : `Swing Tracker — ${crossed.length} out, ${settled.length} back in, ${status.data_through}`;

  return { subject, text: lines.join("\n") };
}
