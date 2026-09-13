/**
 * digest_test.ts — the wording of an email that gets sent to people.
 *
 * Worth testing properly rather than eyeballing once, because every failure mode here is
 * invisible until it has already been delivered: an empty-looking email, a cheerful summary
 * computed from stale data, a count that disagrees with the list beneath it. None of those throw.
 *
 * Pure functions only. No network, no env, no API key, and therefore no possibility of this test
 * sending anything.
 */

import assert from "node:assert/strict";
// Same shim as ingest_test.ts rather than the std library: deno.land is unreachable from the
// coding sandbox (CONSTRAINTS, 2026-09-12), so a std import would pass in CI and fail for anyone
// running the tests while writing them - which is when a failing test is actually useful.
const assertEquals = (a: unknown, b: unknown, msg?: string) => assert.deepEqual(a, b, msg);

import { type Change, renderDigest, type Standing, type Status } from "./render.ts";

const FRESH: Status = {
  data_through: "2026-09-11",
  symbols: 36,
  hours_since_success: 5,
  stale_after_hours: 30,
  is_stale: false,
};

const STALE: Status = { ...FRESH, hours_since_success: 52, is_stale: true };

function change(over: Partial<Change> = {}): Change {
  return {
    symbol: "SNDK",
    param: "pct_off_high_stored",
    d: "2026-09-11",
    prev_d: "2026-09-10",
    value: -30.6,
    prev_value: -28.1,
    prev_verdict: "normal",
    verdict: "below",
    movement: "crossed below",
    now_outside: true,
    ...over,
  };
}

const STANDING: Standing[] = [
  { symbol: "SMCI", param: "pct_off_high_stored", value: -67.4, verdict: "below" },
  { symbol: "SMCI", param: "pct_off_52w_high", value: -31.8, verdict: "below" },
  { symbol: "DELL", param: "close_vs_sma200d", value: 116.7, verdict: "above" },
];

const URL_ = "https://example.test/";

Deno.test("a stale pipeline suppresses the digest entirely, rather than dressing it up", () => {
  // The dangerous email is not a missing one. It is a confident "nothing crossed a norm today"
  // computed from three-day-old data, which reads exactly like a quiet market.
  const { subject, text } = renderDigest(STALE, [change()], STANDING, URL_);
  assert.match(subject, /data is behind/i);
  assert.match(text, /last completed 52 hours ago/);
  // Nothing from the change list may survive into a stale email.
  assertEquals(text.includes("SNDK"), false, "no ticker data in a stale notice");
  assertEquals(text.includes("crossed below"), false);
  assertEquals(text.includes("Still outside"), false);
  assert.match(text, /example\.test/, "the grid link still belongs there");
});

Deno.test("never having succeeded reads differently from having succeeded long ago", () => {
  const never: Status = { ...STALE, hours_since_success: null };
  const { text } = renderDigest(never, [], STANDING, URL_);
  assert.match(text, /has never completed successfully/);
  assertEquals(text.includes("hours ago"), false);
});

Deno.test("a quiet day says so explicitly instead of arriving empty", () => {
  // An email that only turns up on interesting days cannot be told apart from a broken pipeline.
  const { subject, text } = renderDigest(FRESH, [], STANDING, URL_);
  assert.match(text, /Nothing crossed a norm today\./);
  assert.match(subject, /nothing crossed/i);
  assert.match(subject, /2026-09-11/);
  // Even on a quiet day the standing backdrop is reported, or a name 67% off its high is never
  // mentioned again after the day it got there.
  assert.match(text, /Still outside a norm: 3 values across 2 names/);
});

Deno.test("crossings and recoveries are counted and listed separately", () => {
  const changes = [
    change(),
    change({ symbol: "STX", param: "pct_off_52w_high", verdict: "below", now_outside: true }),
    change({
      symbol: "QCOM",
      prev_verdict: "below",
      verdict: "normal",
      movement: "back to normal",
      prev_value: -31.9,
      value: -30.0,
      now_outside: false,
    }),
  ];
  const { subject, text } = renderDigest(FRESH, changes, STANDING, URL_);
  assert.match(subject, /2 out, 1 back in/);
  assert.match(text, /MOVED OUTSIDE A NORM \(2\)/);
  assert.match(text, /BACK INSIDE \(1\)/);
  // Both directions matter: this tracker is as much about trimming as buying, so a recovery must
  // not be silently dropped for being good news.
  assert.match(text, /QCOM.*-31\.9 → -30\.0/);
  assert.match(text, /SNDK.*-28\.1 → -30\.6.*crossed below/);
  // The count in the heading must match the number of lines under it - a mismatch is the kind of
  // thing a reader notices and then stops trusting the whole email over.
  const out = text.split("MOVED OUTSIDE A NORM (2)")[1].split("BACK INSIDE")[0];
  assertEquals(out.trim().split("\n").filter((l) => l.trim()).length, 2);
});

Deno.test("parameters are named as the dashboard names them", () => {
  // A digest that says `pct_off_high_stored` while the page says "Off high" makes the reader
  // translate at exactly the wrong moment.
  const { text } = renderDigest(FRESH, [change()], STANDING, URL_);
  assert.match(text, /off its high/);
  assertEquals(text.includes("pct_off_high_stored"), false);
});

Deno.test("an unmapped parameter falls back to its raw name rather than vanishing", () => {
  // Twelve norms still have no column. When one arrives before its label does, the digest must
  // show something rather than an empty gap.
  const { text } = renderDigest(FRESH, [change({ param: "rs_vs_spx_6m" })], STANDING, URL_);
  assert.match(text, /rs_vs_spx_6m/);
});

Deno.test("a null value renders as a dash, not as NaN or zero", () => {
  const { text } = renderDigest(
    FRESH,
    [change({ prev_value: null, value: null })],
    STANDING,
    URL_,
  );
  assert.match(text, /— → —/);
  assertEquals(/NaN/.test(text), false);
  assertEquals(/undefined/.test(text), false);
});

Deno.test("the subject always carries the date the numbers are from", () => {
  // Read on a phone, possibly a day late. A subject without the close date is unplaceable.
  for (const changes of [[], [change()]]) {
    const { subject } = renderDigest(FRESH, changes, STANDING, URL_);
    assert.match(subject, /2026-09-11/);
  }
});
