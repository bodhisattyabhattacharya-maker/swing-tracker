/**
 * session_test.ts — the session bucketer, pinned.
 *
 * Every test here builds its minutes from ET wall-clock times through `etMinute`, which does its
 * own DST arithmetic from a hard-coded offset per date. That keeps the tests independent of the
 * code under test: if both used `etOffsetMin`, a wrong offset would agree with itself.
 */
// node:assert rather than jsr:@std/assert, matching ingest_test.ts: no remote fetch to run a test.
import assert from "node:assert/strict";
import {
  CLOSE_MIN,
  EARLY_CLOSE_MIN,
  EARLY_CLOSES,
  EARLY_CLOSES_THROUGH,
  etParts,
  type MinuteAgg,
  OPEN_MIN,
  sessionHours,
  SETTLE_MS,
} from "./session.ts";

/** Hard-coded, not derived: EDT is UTC-4, EST is UTC-5. */
const OFFSET_H: Record<string, number> = {
  "2026-09-25": 4, // Friday, EDT
  "2026-12-01": 5, // Tuesday, EST
  "2026-11-27": 5, // Friday after Thanksgiving, EST, early close
  "2027-07-02": 4, // Friday, EDT - an ORDINARY session the bad calendar summary called a half day
  "2026-03-09": 4, // Monday after DST began (2026-03-08)
  "2026-11-02": 5, // Monday after DST ended (2026-11-01)
};

/** Epoch ms for an ET wall-clock minute on a date in OFFSET_H. */
function etMinute(d: string, hh: number, mm: number): number {
  const h = OFFSET_H[d];
  if (h === undefined) throw new Error(`no hard-coded offset for ${d}`);
  return Date.parse(`${d}T00:00:00Z`) + ((hh + h) * 60 + mm) * 60_000;
}

/** Every minute from 04:00 to 19:59 ET - pre-market, the session, and after-hours. */
function fullDay(d: string, base = 100): MinuteAgg[] {
  const out: MinuteAgg[] = [];
  for (let m = 4 * 60; m < 20 * 60; m++) {
    const px = base + m / 1000;
    out.push({ t: etMinute(d, Math.floor(m / 60), m % 60), o: px, h: px + 0.05, l: px - 0.05, c: px + 0.01, v: 10.4 });
  }
  return out;
}

const LATER = Date.parse("2030-01-01T00:00:00Z"); // every bucket in these tests is long settled

// ---------------------------------------------------------------------------- alignment

Deno.test("seven session hours on an ordinary summer day, starting at the 09:30 open", () => {
  const h = sessionHours(fullDay("2026-09-25"), LATER);
  assert.deepStrictEqual(h.length, 7);
  assert.deepStrictEqual(
    h.map((b) => new Date(b.startMs).toISOString().slice(11, 16)),
    ["13:30", "14:30", "15:30", "16:30", "17:30", "18:30", "19:30"], // 09:30 .. 15:30 EDT
  );
  assert.deepStrictEqual(new Date(h[6].endMs).toISOString().slice(11, 16), "20:00"); // 16:00 EDT
  assert.deepStrictEqual(h.map((b) => b.minutes), [60, 60, 60, 60, 60, 60, 30]);
  assert.ok(h.every((b) => b.d === "2026-09-25"));
  assert.deepStrictEqual(h.map((b) => b.closesSession), [false, false, false, false, false, false, true]);
});

Deno.test("winter shifts every bucket by an hour of UTC, not of the session", () => {
  const h = sessionHours(fullDay("2026-12-01"), LATER);
  assert.deepStrictEqual(h.length, 7);
  assert.deepStrictEqual(new Date(h[0].startMs).toISOString().slice(11, 16), "14:30"); // 09:30 EST
  assert.deepStrictEqual(new Date(h[6].endMs).toISOString().slice(11, 16), "21:00"); // 16:00 EST
});

Deno.test("the Mondays after both 2026 DST changes align to the open", () => {
  for (const [d, first] of [["2026-03-09", "13:30"], ["2026-11-02", "14:30"]]) {
    const h = sessionHours(fullDay(d), LATER);
    assert.deepStrictEqual(h.length, 7, d);
    assert.deepStrictEqual(new Date(h[0].startMs).toISOString().slice(11, 16), first, d);
  }
});

Deno.test("extended hours never reach a bucket", () => {
  const h = sessionHours(fullDay("2026-09-25"), LATER);
  // 390 session minutes; the 570 pre-market and after-hours minutes in fullDay are all gone.
  assert.deepStrictEqual(h.reduce((n, b) => n + b.minutes, 0), 390);
});

Deno.test("bucket edges: 09:29 out, 09:30 in, 10:29 first bucket, 10:30 second, 15:59 last, 16:00 out", () => {
  const d = "2026-09-25";
  const at = (hh: number, mm: number): MinuteAgg => ({ t: etMinute(d, hh, mm), c: 1 });
  const h = sessionHours([at(9, 29), at(9, 30), at(10, 29), at(10, 30), at(15, 59), at(16, 0)], LATER);
  assert.deepStrictEqual(h.map((b) => b.minutes), [2, 1, 1]); // 09:30+10:29 | 10:30 | 15:59
  assert.deepStrictEqual(etParts(h[0].startMs).minuteOfDay, OPEN_MIN);
  assert.deepStrictEqual(etParts(h[2].endMs).minuteOfDay, CLOSE_MIN);
});

// ---------------------------------------------------------------------------- early closes

Deno.test("an early close ends the session at 13:00 and drops the after-hours that follows", () => {
  const h = sessionHours(fullDay("2026-11-27"), LATER);
  assert.deepStrictEqual(h.length, 4); // 09:30, 10:30, 11:30, 12:30
  assert.deepStrictEqual(h.map((b) => b.minutes), [60, 60, 60, 30]);
  assert.deepStrictEqual(etParts(h[3].endMs).minuteOfDay, EARLY_CLOSE_MIN);
  assert.deepStrictEqual(h.map((b) => b.closesSession), [false, false, false, true]);
  // Without the calendar, 12:30 would have become a full hour and three more bars would exist,
  // built entirely from after-hours prints.
});

Deno.test("2 July 2027 is a FULL session - the mistake the first calendar summary would have made", () => {
  // The summary read on 2026-09-27 listed this date as a 1:00 p.m. close. The exchange's own
  // release does not: 5 July is the observed holiday and 2 July trades a normal day.
  assert.ok(!EARLY_CLOSES.has("2027-07-02"));
  const h = sessionHours(fullDay("2027-07-02"), LATER);
  assert.deepStrictEqual(h.length, 7);
  assert.deepStrictEqual(h.reduce((n, b) => n + b.minutes, 0), 390);
});

Deno.test("the dates that are FULL closures are not listed as early closes", () => {
  // Each of these was presented as an early close by the bad summary; each is a closed day.
  for (const d of ["2026-07-03", "2027-12-24"]) assert.ok(!EARLY_CLOSES.has(d), d);
});

Deno.test("every early close is a weekday inside the covered years", () => {
  for (const d of EARLY_CLOSES) {
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    assert.ok(dow >= 1 && dow <= 5, `${d} is not a weekday`);
    assert.ok(Number(d.slice(0, 4)) <= EARLY_CLOSES_THROUGH, `${d} is past EARLY_CLOSES_THROUGH`);
  }
});

Deno.test("the early-close calendar has not run out", () => {
  // NYSE publishes three years ahead each November, so when this fails the answer already exists.
  // Update EARLY_CLOSES from the exchange's release - verbatim, not from a summary of it.
  const year = new Date().getUTCFullYear();
  assert.ok(
    EARLY_CLOSES_THROUGH >= year,
    `EARLY_CLOSES covers through ${EARLY_CLOSES_THROUGH}; it is now ${year}. ` +
      `Half days this year would absorb after-hours trading into the 12:30 bar.`,
  );
});

// ---------------------------------------------------------------------------- the bar itself

Deno.test("OHLC is taken by time, not by arrival order", () => {
  const d = "2026-09-25";
  const rows: MinuteAgg[] = [
    { t: etMinute(d, 9, 45), o: 11, h: 15, l: 10, c: 12, v: 1 },
    { t: etMinute(d, 9, 30), o: 10, h: 11, l: 9, c: 11, v: 1 }, // first by time, second by arrival
    { t: etMinute(d, 10, 29), o: 12, h: 13, l: 8, c: 13, v: 1 }, // last by time
    { t: etMinute(d, 10, 0), o: 12, h: 14, l: 11, c: 12.5, v: 1 },
  ];
  const [b] = sessionHours(rows, LATER);
  assert.deepStrictEqual([b.open, b.high, b.low, b.close], [10, 15, 8, 13]);
});

Deno.test("volume is summed, then rounded - not rounded per minute", () => {
  const d = "2026-09-25";
  // Sixty minutes of 0.4 shares: 24 summed. Rounding each minute first would give 0.
  const rows = Array.from({ length: 60 }, (_, i) => ({ t: etMinute(d, 9, 30) + i * 60_000, c: 1, v: 0.4 }));
  assert.deepStrictEqual(sessionHours(rows, LATER)[0].volume, 24);
});

Deno.test("a gap in the vendor's minutes shows in the count, not as a full hour", () => {
  const d = "2026-09-25";
  const rows = fullDay(d).filter((m) => {
    const mm = etParts(m.t).minuteOfDay;
    return !(mm >= 11 * 60 && mm < 11 * 60 + 20); // a 20-minute halt inside the 10:30 bucket
  });
  const h = sessionHours(rows, LATER);
  assert.deepStrictEqual(h[1].minutes, 40);
});

Deno.test("rows without a close or with a bad timestamp are dropped, not fatal", () => {
  const d = "2026-09-25";
  const h = sessionHours([
    { t: etMinute(d, 9, 30), c: 1 },
    { t: etMinute(d, 9, 31) }, // no close
    { t: Number.NaN, c: 2 },
    { t: etMinute(d, 9, 32), c: Number.NaN },
  ], LATER);
  assert.deepStrictEqual(h.length, 1);
  assert.deepStrictEqual(h[0].minutes, 1);
});

Deno.test("a full-day holiday produces nothing, because nothing traded", () => {
  assert.deepStrictEqual(sessionHours([], LATER), []);
});

// ---------------------------------------------------------------------------- settling

Deno.test("a bucket is not stored until the delayed feed has had time to finish it", () => {
  const d = "2026-09-25";
  const all = fullDay(d);
  const lastEnd = sessionHours(all, LATER)[6].endMs;
  assert.deepStrictEqual(sessionHours(all, lastEnd + SETTLE_MS - 60_000).length, 6, "one minute short: dropped");
  assert.deepStrictEqual(sessionHours(all, lastEnd + SETTLE_MS).length, 7, "exactly settled: kept");
});

Deno.test("a manual run mid-session stores only the hours already finished", () => {
  const d = "2026-09-25";
  const noonish = etMinute(d, 12, 0);
  const minutesSoFar = fullDay(d).filter((m) => m.t < noonish);
  const h = sessionHours(minutesSoFar, noonish);
  // 09:30 and 10:30 have ended and settled; 11:30 is in progress and must not be stored.
  assert.deepStrictEqual(h.length, 2);
  // And neither of them is the day's close, so the grid shows no hourly value for today yet.
  assert.ok(h.every((b) => !b.closesSession));
});
