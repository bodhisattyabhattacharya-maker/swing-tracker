/**
 * session.ts — one-minute aggregates in, session-aligned hourly bars out.
 *
 * PURE. No network, no Deno.env, no clock except the `nowMs` argument. Everything interesting
 * about hourly bars happens here, and everything that happens here can go wrong silently, so it
 * lives where `ingest_test.ts` can pin every edge case against fixtures.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL
 *
 * Polygon's hour aggregates start on the CLOCK — 09:00, 10:00, 11:00 — and include extended-hours
 * trading. TradingView's 1H bars start at the 09:30 OPEN and exclude it:
 *
 *     09:30–10:30  10:30–11:30  11:30–12:30  12:30–13:30  13:30–14:30  14:30–15:30  15:30–16:00
 *
 * seven bars a session, the last one thirty minutes long. Hourly RSI is read against 30/70, and
 * which trades land in which bar moves it. A clock-aligned RSI that disagrees with the chart the
 * reader is looking at is worse than no hourly RSI, because it is plausible.
 *
 * So we fetch minutes and bucket them ourselves. That makes the alignment a property of this
 * file rather than an assumption about the vendor's — and it is why 30-minute bars paired
 * together were rejected: same request count, and it would have depended on where Polygon puts
 * its 30-minute boundaries, which nobody had measured (decision 0058).
 *
 * ---------------------------------------------------------------------------
 * EARLY CLOSES ARE THE TRAP
 *
 * On a half day the regular session ends at 13:00 ET — but after-hours trading does not stop, and
 * Polygon's minute aggregates include it. A filter of "09:30 ≤ t < 16:00" would fold three hours
 * of after-hours prints into the session on every early close, and the 12:30 bar would absorb them.
 * So the close is a function of the date, and the dates are listed below.
 *
 * THE LIST WAS VERIFIED AGAINST THE EXCHANGE'S OWN RELEASE, VERBATIM, and that sentence is load-
 * bearing. The first summary of NYSE's 2025–2027 calendar this project read (2026-09-27) invented
 * three early closes: 3 July 2026 (actually a FULL closure, Independence Day observed), 2 July 2027
 * (an ORDINARY full session) and 24 December 2027 (also a full closure, Christmas observed). Using
 * it would have cut three hours of real trading off 2 July 2027 with nothing to show for it.
 * Source: NYSE Group press release, 8 November 2024, footnotes * ** ***.
 *
 * A full-day holiday needs no entry: no minutes exist, so no buckets are made.
 *
 * `EARLY_CLOSES_THROUGH` names the last year covered, and a test fails the build once the current
 * year passes it. NYSE publishes three years ahead each November, so that failure always has an
 * answer available.
 */

/** Minutes after ET midnight. */
export const OPEN_MIN = 9 * 60 + 30; // 09:30
export const CLOSE_MIN = 16 * 60; // 16:00
export const EARLY_CLOSE_MIN = 13 * 60; // 13:00

/** NYSE 1:00 p.m. closes, ET trading dates. Verified verbatim - see the header. */
export const EARLY_CLOSES: ReadonlySet<string> = new Set([
  "2025-07-03", // Thursday - the day before Independence Day
  "2025-11-28", // Friday - the day after Thanksgiving
  "2025-12-24", // Wednesday - Christmas Eve
  "2026-11-27", // Friday - the day after Thanksgiving. NO July early close: 3 July is closed.
  "2026-12-24", // Thursday - Christmas Eve
  "2027-11-26", // Friday - the day after Thanksgiving. NO July or Christmas Eve early close:
  //                 5 July and 24 December 2027 are both observed holidays, i.e. closed.
]);

/** The last calendar year `EARLY_CLOSES` covers. A test fails once the current year passes it. */
export const EARLY_CLOSES_THROUGH = 2027;

/**
 * How long after a bucket ends before it counts as final.
 *
 * Starter is a 15-minute delayed feed. A bucket that ended less than that long ago may still be
 * missing its last prints, and storing it would bake a partial bar into RSI until a later run
 * happened to overwrite it. The scheduled job runs hours after the close, so this only bites a
 * manual run during market hours - which is exactly the run someone would use to "check it works".
 */
export const SETTLE_MS = 15 * 60_000;

/** One-minute aggregate, as Polygon sends it. `t` is the minute's START, epoch milliseconds. */
export interface MinuteAgg {
  t: number;
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  v?: number;
}

export interface SessionHour {
  /** ET trading date, YYYY-MM-DD. */
  d: string;
  /** Bucket start and end, epoch ms. End is the session close for the last bucket of the day. */
  startMs: number;
  endMs: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
  /**
   * How many one-minute bars fed this bucket. 60 for an ordinary hour, 30 for the last one.
   * Published rather than discarded because a short count is the only evidence a bucket was
   * built from a gap in the vendor's minutes - a halted stock, a feed outage - and not from a
   * full hour of trading.
   */
  minutes: number;
  /**
   * True only for the bucket that ends at that day's session close - 16:00, or 13:00 on an early
   * close. The grid shows an hourly value for day d only from this bucket, so a day whose last hour
   * has not been stored (a manual run mid-session, a vendor gap at 15:30) shows a dash, not the RSI
   * of whichever hour happened to be newest. "Last row stored" and "last hour of the session" are
   * different facts; only the second is the day's hourly close.
   */
  closesSession: boolean;
}

// ---------------------------------------------------------------------------
// Eastern time, without a date library.
//
// Deno ships full ICU, so Intl does the daylight-saving arithmetic. What it does NOT do cheaply is
// run 57,600 times, which is what a 60-session backfill with extended hours asks of it. The ET
// offset is constant for a whole UTC calendar day during market hours - both US transitions happen
// at 02:00 local, on Sundays - so it is computed once per UTC date and cached.
// ---------------------------------------------------------------------------

const offsetFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  timeZoneName: "shortOffset",
});
const offsetCache = new Map<string, number>();

/** Minutes to ADD to UTC to get ET, for the instant given (−240 in summer, −300 in winter). */
export function etOffsetMin(ms: number): number {
  // Sampled at 16:00Z of that UTC day - noon ET, safely away from any transition.
  const utcDay = new Date(ms).toISOString().slice(0, 10);
  const cached = offsetCache.get(utcDay);
  if (cached !== undefined) return cached;
  const probe = Date.parse(`${utcDay}T16:00:00Z`);
  const name = offsetFmt.formatToParts(new Date(probe)).find((p) => p.type === "timeZoneName")?.value ?? "";
  const m = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(name);
  if (!m) throw new Error(`session.ts: could not read an ET offset from "${name}"`);
  const minutes = (Number(m[2]) * 60 + Number(m[3] ?? 0)) * (m[1] === "-" ? -1 : 1);
  offsetCache.set(utcDay, minutes);
  return minutes;
}

/** The ET trading date and minute-of-day for an instant. */
export function etParts(ms: number): { d: string; minuteOfDay: number } {
  const local = ms + etOffsetMin(ms) * 60_000;
  const iso = new Date(local).toISOString();
  return { d: iso.slice(0, 10), minuteOfDay: Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16)) };
}

/** The ET session close for a trading date, in minutes after ET midnight. */
export function sessionCloseMin(d: string): number {
  return EARLY_CLOSES.has(d) ? EARLY_CLOSE_MIN : CLOSE_MIN;
}

/** Epoch ms for an ET date + minute-of-day. Inverse of `etParts` within a trading day. */
function etToMs(d: string, minuteOfDay: number): number {
  const naive = Date.parse(`${d}T00:00:00Z`) + minuteOfDay * 60_000;
  // The offset in force during that ET day's session. Probed at the naive instant, which is on the
  // same UTC date as the session for every minute between 09:30 and 16:00 ET.
  return naive - etOffsetMin(naive) * 60_000;
}

/**
 * Bucket one-minute aggregates into session-aligned hours.
 *
 * - Minutes outside 09:30 ≤ t < close(d) are dropped: pre-market, after-hours, and the after-hours
 *   that follows an early close.
 * - A minute with no close is dropped; every parameter downstream is built on close.
 * - OHLC is first open, max high, min low, last close — by TIME, not by arrival order, because
 *   pagination does not promise order across pages.
 * - A bucket whose end is not at least SETTLE_MS in the past is dropped as provisional.
 *
 * Returns buckets in time order. Never throws on bad input rows; a vendor quirk in one minute
 * must not cost a symbol its whole night.
 */
export function sessionHours(minutes: MinuteAgg[], nowMs: number): SessionHour[] {
  const sorted = minutes
    .filter((m) => typeof m.t === "number" && Number.isFinite(m.t) && typeof m.c === "number" && Number.isFinite(m.c))
    .slice()
    .sort((a, b) => a.t - b.t);

  const byKey = new Map<string, { d: string; idx: number; rows: MinuteAgg[] }>();
  for (const m of sorted) {
    const { d, minuteOfDay } = etParts(m.t);
    if (minuteOfDay < OPEN_MIN || minuteOfDay >= sessionCloseMin(d)) continue;
    const idx = Math.floor((minuteOfDay - OPEN_MIN) / 60);
    const key = `${d}#${idx}`;
    let b = byKey.get(key);
    if (!b) {
      b = { d, idx, rows: [] };
      byKey.set(key, b);
    }
    b.rows.push(m);
  }

  const out: SessionHour[] = [];
  for (const { d, idx, rows } of byKey.values()) {
    const startMin = OPEN_MIN + idx * 60;
    const endMin = Math.min(startMin + 60, sessionCloseMin(d));
    const startMs = etToMs(d, startMin);
    const endMs = etToMs(d, endMin);
    if (endMs + SETTLE_MS > nowMs) continue;

    const highs = rows.map((r) => r.h).filter((x): x is number => typeof x === "number" && Number.isFinite(x));
    const lows = rows.map((r) => r.l).filter((x): x is number => typeof x === "number" && Number.isFinite(x));
    const vols = rows.map((r) => r.v).filter((x): x is number => typeof x === "number" && Number.isFinite(x));
    const first = rows[0];
    const last = rows[rows.length - 1];
    out.push({
      d,
      startMs,
      endMs,
      open: typeof first.o === "number" ? first.o : null,
      high: highs.length ? Math.max(...highs) : null,
      low: lows.length ? Math.min(...lows) : null,
      close: last.c as number,
      // Polygon's volume is a float (CONSTRAINTS.md 2026-09-13); summed, THEN rounded, so sixty
      // fractional minutes do not each lose half a share to rounding before they are added.
      volume: vols.length ? Math.round(vols.reduce((a, b) => a + b, 0)) : null,
      minutes: rows.length,
      closesSession: endMin === sessionCloseMin(d),
    });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}
