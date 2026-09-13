/**
 * ingest_test.ts — unit tests for the pure parts of the ingest function.
 *
 * Run:   deno test --allow-env supabase/functions/ingest/   (needs only the npm registry;
 *        --allow-env is for the yaml package, which peeks at process.env on load)
 * Why no network tests: the dev sandbox has no route to Yahoo (CLAUDE.md constraint 1), and a
 * test that depends on an unofficial endpoint being up is not a test. The fixtures below are
 * the shapes Yahoo actually returns, including the two "200 but broken" ones.
 *
 * These tests encode intent (CODE_STYLE): each one fails if a business rule changes, not if a
 * line of code moves. In particular: null adj_close is NOT substituted with close; a null close
 * drops the bar; an undeclared theme is an error, not a default; a duplicate date keeps the
 * later bar; an anon JWT is refused and a service_role JWT accepted regardless of the env var.
 */

import assert from "node:assert/strict";
const assertEquals = (a: unknown, b: unknown, msg?: string) => assert.deepEqual(a, b, msg);
const assertThrows = (fn: () => unknown, _e: unknown, includes: string) =>
  assert.throws(fn, (err: unknown) => err instanceof Error && err.message.includes(includes));
import { chartUrl, mapChart, RateLimitError, toTradingDate, yahoo, YAHOO_SOURCE } from "./yahoo.ts";
import { parseWatchlist } from "./watchlist.ts";
import { callerAllowed, jwtRole } from "./auth.ts";

// ---------------------------------------------------------------------------
// Fixtures - trimmed real shapes
// ---------------------------------------------------------------------------

/** Three sessions of MU, second bar has a null volume, third has a null close (padding). */
const CHART_OK = {
  chart: {
    result: [{
      timestamp: [1756992600, 1757079000, 1757338200], // 2025-09-04, -05, -08 13:30Z
      indicators: {
        quote: [{
          open: [120.0, 121.5, 122.0],
          high: [125.0, 123.0, 124.0],
          low: [119.0, 120.0, 121.0],
          close: [124.0, 122.0, null],
          volume: [1000000, null, 900000],
        }],
        adjclose: [{ adjclose: [123.5, 121.5, null] }],
      },
    }],
    error: null,
  },
};

const CHART_NO_ADJ = {
  chart: {
    result: [{
      timestamp: [1756992600],
      indicators: { quote: [{ open: [1], high: [2], low: [0.5], close: [1.5], volume: [10] }] },
    }],
  },
};

const CHART_BAD_SYMBOL = {
  chart: { result: null, error: { code: "Not Found", description: "No data found, symbol may be delisted" } },
};

const CHART_NO_TIMESTAMPS = { chart: { result: [{ indicators: { quote: [{}] } }], error: null } };

const WATCHLIST_YML = `
themes:
  memory-storage: { label: "Memory", rankable: true }
  diversified:    { label: "Diversified", rankable: false }
tickers:
  - { symbol: MU,  name: Micron, theme: memory-storage, tag: hbm, bellwether: true }
  - { symbol: JPM, name: JPMorgan, theme: diversified }
indices:
  - { symbol: "^VIX", name: VIX }
`;

// ---------------------------------------------------------------------------
// mapChart
// ---------------------------------------------------------------------------

Deno.test("mapChart keeps bars with a close, drops the null-close padding row", () => {
  const bars = mapChart(CHART_OK, "MU");
  assertEquals(bars.length, 2);
  assertEquals(bars[0].close, 124.0);
  assertEquals(bars[1].volume, null, "a null volume is kept as null, not dropped and not zeroed");
});

Deno.test("mapChart never substitutes close for a missing adj_close", () => {
  const bars = mapChart(CHART_NO_ADJ, "X");
  assertEquals(bars[0].adj_close, null);
  assertEquals(bars[0].close, 1.5);
});

Deno.test("mapChart treats HTTP-200-with-chart.error as a failure", () => {
  assertThrows(() => mapChart(CHART_BAD_SYMBOL, "ZZZZ"), Error, "delisted");
});

Deno.test("mapChart treats a missing timestamp array as a failure, not an empty success", () => {
  assertThrows(() => mapChart(CHART_NO_TIMESTAMPS, "THIN"), Error, "no timestamp array");
});

Deno.test("toTradingDate maps a 13:30Z session open to that UTC calendar date", () => {
  assertEquals(toTradingDate(1756992600), "2025-09-04");
});

// ---------------------------------------------------------------------------
// yahoo.daily / hourly - fetch stubbed
// ---------------------------------------------------------------------------

function withFetch<T>(body: unknown, fn: () => Promise<T>, status = 200): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      typeof body === "string"
        ? new Response(body, { status })
        : new Response(JSON.stringify(body), { status }),
    )) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = real;
  });
}

Deno.test("yahoo.daily shapes rows for daily_bars and stamps the source", async () => {
  const rows = await withFetch(CHART_OK, () => yahoo.daily("MU", "incremental"));
  assertEquals(rows.length, 2);
  assertEquals(rows[0], {
    symbol: "MU",
    d: "2025-09-04",
    open: 120.0,
    high: 125.0,
    low: 119.0,
    close: 124.0,
    adj_close: 123.5,
    volume: 1000000,
    source: YAHOO_SOURCE,
  });
});

Deno.test("yahoo.daily keeps the LATER bar when two share a date (live candle after settled)", async () => {
  const dup = structuredClone(CHART_OK);
  dup.chart.result[0].timestamp = [1756992600, 1756992600 + 3600, 1757338200]; // same UTC date
  const rows = await withFetch(dup, () => yahoo.daily("MU", "incremental"));
  assertEquals(rows.length, 1);
  assertEquals(rows[0].close, 122.0);
});

Deno.test("yahoo.hourly writes bar-open timestamps in UTC ISO and no adj_close column", async () => {
  const rows = await withFetch(CHART_OK, () => yahoo.hourly("MU", "incremental"));
  assertEquals(rows[0].ts, "2025-09-04T13:30:00.000Z");
  assertEquals("adj_close" in rows[0], false);
});

// ---------------------------------------------------------------------------
// parseWatchlist
// ---------------------------------------------------------------------------

Deno.test("parseWatchlist: rankable comes from the theme, indices are flagged and unrankable", () => {
  const rows = parseWatchlist(WATCHLIST_YML);
  const by = Object.fromEntries(rows.map((r) => [r.symbol, r]));
  assertEquals(rows.length, 3);
  assertEquals(by.MU.rankable, true);
  assertEquals(by.MU.bellwether, true);
  assertEquals(by.JPM.rankable, false, "diversified is rankable: false in the yml");
  assertEquals(by.JPM.bellwether, false);
  assertEquals(by.JPM.tag, null);
  assertEquals(by["^VIX"].is_index, true);
  assertEquals(by["^VIX"].rankable, false);
  assertEquals(by["^VIX"].theme, "index");
});

Deno.test("parseWatchlist rejects an undeclared theme instead of defaulting", () => {
  const bad = WATCHLIST_YML.replace("theme: diversified", "theme: diversifed");
  assertThrows(() => parseWatchlist(bad), Error, "undeclared theme");
});

Deno.test("parseWatchlist rejects a duplicate symbol", () => {
  const bad = WATCHLIST_YML + `  - { symbol: MU, name: dup }\n`;
  assertThrows(() => parseWatchlist(bad), Error, "duplicate symbol");
});

// ---------------------------------------------------------------------------
// auth - unsigned test JWTs; the gateway is what verifies signatures in production
// ---------------------------------------------------------------------------

/** header.payload.signature with a throwaway signature - signature is never checked here. */
function fakeJwt(payload: Record<string, unknown>): string {
  const b64url = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.sig`;
}
const SERVICE = fakeJwt({ iss: "supabase", role: "service_role", exp: 2000000000 });
const ANON = fakeJwt({ iss: "supabase", role: "anon", exp: 2000000000 });

Deno.test("jwtRole reads the role claim and returns null for non-JWTs", () => {
  assertEquals(jwtRole(SERVICE), "service_role");
  assertEquals(jwtRole(ANON), "anon");
  assertEquals(jwtRole("sb_secret_notajwt"), null);
  assertEquals(jwtRole("a.b"), null);
  assertEquals(jwtRole("a.!!!.c"), null);
});

Deno.test("callerAllowed: service_role JWT passes even when it differs from the env var (INCIDENTS 2026-09-13)", () => {
  assertEquals(callerAllowed(SERVICE, "some-other-runtime-value"), true);
  assertEquals(callerAllowed(SERVICE, undefined), true, "missing env must not lock out the service role");
});

Deno.test("callerAllowed: anon JWT is refused, with or without an env var", () => {
  assertEquals(callerAllowed(ANON, "some-other-runtime-value"), false);
  assertEquals(callerAllowed(ANON, undefined), false);
});

Deno.test("callerAllowed: exact byte match with the env var passes (non-JWT key formats)", () => {
  assertEquals(callerAllowed("sb_secret_abc", "sb_secret_abc"), true);
  assertEquals(callerAllowed("sb_secret_abc", "sb_secret_abd"), false);
  assertEquals(callerAllowed("sb_secret_ab", "sb_secret_abc"), false, "length mismatch is a plain no, not a throw");
});

Deno.test("callerAllowed: no token is refused", () => {
  assertEquals(callerAllowed(null, "anything"), false);
});

// ---------------------------------------------------------------------------
// chartUrl - the downsampling trap, pinned (INCIDENTS.md 2026-09-13)
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date("2026-09-13T00:00:00Z"); // epoch 1789257600

Deno.test("chartUrl: daily FULL uses epoch bounds and never range=max", () => {
  const u = chartUrl("MU", "daily", "full", FIXED_NOW);
  assertEquals(u.includes("range="), false, "range=max&interval=1d silently returns quarterly bars");
  assertEquals(u.includes("period1=0"), true);
  assertEquals(u.includes("interval=1d"), true);
  // period2 is tomorrow, so today's session is inside the window.
  assertEquals(u.includes(`period2=${1789257600 + 86400}`), true);
});

Deno.test("chartUrl: daily incremental is a one-month range of daily bars", () => {
  assertEquals(
    chartUrl("MU", "daily", "incremental", FIXED_NOW),
    "https://query1.finance.yahoo.com/v8/finance/chart/MU?range=1mo&interval=1d&includeAdjustedClose=true",
  );
});

Deno.test("chartUrl: hourly keeps the ranges verified live (5d / 2y, 1h bars)", () => {
  assertEquals(chartUrl("MU", "hourly", "incremental", FIXED_NOW).includes("range=5d&interval=1h"), true);
  assertEquals(chartUrl("MU", "hourly", "full", FIXED_NOW).includes("range=2y&interval=1h"), true);
});

Deno.test("chartUrl: a caret index symbol is percent-encoded", () => {
  assertEquals(chartUrl("^VIX", "daily", "incremental", FIXED_NOW).includes("/chart/%5EVIX?"), true);
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

Deno.test("a 429 raises RateLimitError, not a generic error - the caller must stop, not skip", async () => {
  let caught: unknown = null;
  try {
    // Yahoo returns plain text for 429, so this also proves we check status before parsing JSON.
    await withFetch("Too Many Requests\r\n", () => yahoo.daily("MU", "incremental"), 429);
  } catch (e) {
    caught = e;
  }
  assertEquals(caught instanceof RateLimitError, true);
});

Deno.test("a non-429 HTTP failure stays a plain error - only 429 aborts a run", async () => {
  let caught: unknown = null;
  try {
    await withFetch("gateway blew up", () => yahoo.daily("MU", "incremental"), 503);
  } catch (e) {
    caught = e;
  }
  assertEquals(caught instanceof Error, true);
  assertEquals(caught instanceof RateLimitError, false);
});
