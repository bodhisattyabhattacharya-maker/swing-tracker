/**
 * digest/render.ts — the email's wording, as a pure function.
 *
 * Separate from index.ts for one concrete reason: index.ts calls `Deno.serve` at module top level,
 * so importing anything from it inside a test starts a real HTTP listener and leaks it. The same
 * trap was hit with the ingest function; keeping the renderer here means the wording of an email
 * that gets sent to people is testable without a network, an API key, or any risk of sending.
 *
 * Everything here is pure. No fetch, no env, no clock.
 *
 * NULL MEANS UNKNOWN, EMPTY MEANS NOTHING HAPPENED. Since 2026-09-14 each of the three inputs can
 * arrive as `null`, meaning the read failed after retries (see retry.ts and INCIDENTS.md). The two
 * must never be conflated: `changes = []` is "nothing crossed today", a real and common result;
 * `changes = null` is "we could not find out", and rendering that as a quiet day would be the most
 * believable lie this email is capable of telling.
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
  status: Status | null,
  changes: Change[] | null,
  standing: Standing[] | null,
  gridUrl: string,
  /** Names of reads that failed after retries. Empty on a healthy run. */
  unavailable: string[] = [],
): { subject: string; text: string } {
  const degraded = unavailable.length > 0;

  // The stale path is still first and exclusive - but only when we could actually READ freshness.
  // A null status is not evidence of freshness, so it must not take this branch.
  if (status?.is_stale) {
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
        ...(degraded
          ? ["", `Separately, these could not be read: ${unavailable.join(", ")}.`]
          : []),
        "",
        `Grid: ${gridUrl}`,
      ].join("\n"),
    };
  }

  const crossed = changes?.filter((c) => c.now_outside) ?? [];
  const settled = changes?.filter((c) => !c.now_outside) ?? [];

  const lines: string[] = [];

  // A read failure is stated at the top, in the reader's terms, before any number they might
  // otherwise take as complete. It does NOT suppress the rest: two of the three reads usually
  // succeeded, and throwing their contents away is what went wrong on 2026-09-14.
  if (degraded) {
    lines.push(`INCOMPLETE — could not read: ${unavailable.join(", ")}.`);
    if (status === null) {
      lines.push("Freshness is unknown, so the numbers below may be from an older close.");
    }
    if (changes === null) {
      lines.push("Today's crossings are missing. This is NOT a quiet day - it is an unread one.");
    }
    lines.push("");
  }

  lines.push(
    status === null
      ? "Close date unknown. Names tracked unknown."
      : `Close of ${status.data_through}. ${status.symbols ?? "?"} names tracked.`,
  );
  lines.push("");

  if (changes === null) {
    // Never "Nothing crossed a norm today." - see the header note on null versus empty.
    lines.push("Crossings could not be read for this run; see the note above.");
  } else if (changes.length === 0) {
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
  lines.push("");
  if (standing === null) {
    lines.push("Standing summary could not be read for this run.");
  } else {
    const bySymbol = new Set(standing.map((s) => s.symbol));
    lines.push(
      `Still outside a norm: ${standing.length} values across ${bySymbol.size} names.`,
    );
  }
  lines.push("");
  lines.push(`Full grid: ${gridUrl}`);

  // The subject is the only part most readers see before deciding whether to trust the contents,
  // so a partial email says so there rather than only in the body.
  const when = status?.data_through ?? "date unknown";
  const subject = degraded
    ? `Swing Tracker — INCOMPLETE digest, ${when}`
    : changes!.length === 0
    ? `Swing Tracker — nothing crossed, ${when}`
    : `Swing Tracker — ${crossed.length} out, ${settled.length} back in, ${when}`;

  return { subject, text: lines.join("\n") };
}
