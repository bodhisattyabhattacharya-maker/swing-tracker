/**
 * reference_test.ts — the pure parts of the Massive reference-data fetch (Stage F2): splits and the
 * ticker overview's share counts. Fixtures are in the vendor's documented shape with invented
 * numbers, as in sec_test.ts.
 */
import assert from "node:assert/strict";
import { mapOverview, mapSplits, splitsUrl, tickerOverviewUrl } from "./polygon.ts";

Deno.test("reference URLs: one ticker, the vendor host, oldest split first", () => {
  assert.equal(tickerOverviewUrl("BRK.B"), "https://api.polygon.io/v3/reference/tickers/BRK.B");
  const u = new URL(splitsUrl("NVDA"));
  assert.equal(u.host, "api.polygon.io");
  assert.equal(u.searchParams.get("ticker"), "NVDA");
  assert.equal(u.searchParams.get("limit"), "1000");
});

Deno.test("mapSplits keeps from/to exactly as sent, forward and reverse", () => {
  const { rows, dropped } = mapSplits({
    results: [
      { ticker: "FIX", execution_date: "2024-06-10", split_from: 1, split_to: 10 },
      { ticker: "FIX", execution_date: "2021-08-02", split_from: 8, split_to: 1 },
    ],
  }, "FIX");
  assert.equal(dropped, 0);
  assert.deepEqual(rows.map((r) => [r.execution_date, r.split_from, r.split_to]).sort(), [
    ["2021-08-02", 8, 1],
    ["2024-06-10", 1, 10],
  ]);
});

Deno.test("mapSplits drops what it cannot trust and counts it - a wrong ratio would rewrite history", () => {
  const { rows, dropped } = mapSplits({
    results: [
      { ticker: "OTHER", execution_date: "2024-06-10", split_from: 1, split_to: 10 },
      { ticker: "FIX", execution_date: "June 10", split_from: 1, split_to: 10 },
      { ticker: "FIX", execution_date: "2024-06-10", split_from: 0, split_to: 10 },
      { ticker: "FIX", execution_date: "2024-06-10", split_from: "1", split_to: 10 },
      { ticker: "FIX", execution_date: "2024-06-10", split_from: 2, split_to: 2 },
    ],
  }, "FIX");
  assert.equal(rows.length, 0);
  assert.equal(dropped, 5);
});

Deno.test("mapSplits: a repeat is one row; two different ratios on one date throw", () => {
  const same = { ticker: "FIX", execution_date: "2024-06-10", split_from: 1, split_to: 10 };
  assert.equal(mapSplits({ results: [same, same] }, "FIX").rows.length, 1);
  assert.throws(
    () => mapSplits({ results: [same, { ...same, split_to: 4 }] }, "FIX"),
    /two different splits/,
  );
  assert.throws(() => mapSplits({ status: "OK" }, "FIX"), /no results array/);
});

Deno.test("mapOverview takes the all-class weighted count; none is null, a foreign answer throws", () => {
  const row = mapOverview({
    results: { ticker: "FIX", weighted_shares_outstanding: 12_000_000_000, share_class_shares_outstanding: 5_800_000_000 },
  }, "FIX", "2026-09-29");
  assert.deepEqual(row, {
    symbol: "FIX",
    as_of: "2026-09-29",
    weighted_shares: 12_000_000_000,
    class_shares: 5_800_000_000,
    source: "polygon-reference",
  });
  assert.equal(mapOverview({ results: { ticker: "FIX" } }, "FIX", "2026-09-29"), null);
  assert.equal(mapOverview({ results: { ticker: "FIX", weighted_shares_outstanding: 0 } }, "FIX", "2026-09-29"), null);
  assert.throws(() => mapOverview({ results: { ticker: "OTHER", weighted_shares_outstanding: 1 } }, "FIX", "2026-09-29"), /answered for OTHER/);
  assert.throws(() => mapOverview({}, "FIX", "2026-09-29"), /no results object/);
});
