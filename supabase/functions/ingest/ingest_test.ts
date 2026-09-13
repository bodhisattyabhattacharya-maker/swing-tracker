/**
 * ingest_test.ts — unit tests for the pure parts of the ingest function.
 *
 * Run:   deno test --allow-env supabase/functions/ingest/   (needs only the npm registry;
 *        --allow-env is for the yaml package, which peeks at process.env on load)
 *
 * Why no network tests: the dev sandbox has no route to any market-data provider (CLAUDE.md
 * constraint 1), and a test that depends on a third party being up is not a test. The fixtures
 * below are the response shapes each provider actually returns, including the ones that arrive
 * as HTTP 200 while being unusable.
 *
 * These tests encode intent (CODE_STYLE): each should fail if a business RULE changes, not if a
 * line moves. The rules being pinned here, each of which has already cost us a bug or would:
 *   - the daily URL carries `adjusted=true` and an explicit date window, never a `range=`
 *     shorthand (INCIDENTS.md 2026-09-13: `range=max` silently returned quarterly bars)
 *   - `adj_close` is never filled from `close` (Polygon is split-adjusted only)
 *   - a FRED "." observation is dropped, never zeroed or carried forward
 *   - routing is exhaustive and disjoint: FRED owns "^" symbols, Polygon owns the rest
 *   - a 429 raises RateLimitError so the caller stops instead of skipping
 */

import assert from "node:assert/strict";
const assertEquals = (a: unknown, b: unknown, msg?: string) => assert.deepEqual(a, b, msg);
const assertThrows = (fn: () => unknown, includes: string) =>
  assert.throws(fn, (err: unknown) => err instanceof Error && err.message.includes(includes));

import { RateLimitError } from "./provider.ts";
import { aggsUrl, aggTradingDate, mapAggs, polygon, POLYGON_SOURCE } from "./polygon.ts";
import { fred, FRED_SOURCE, mapObservations, observationsUrl, SERIES } from "./fred.ts";
import { parseWatchlist } from "./watchlist.ts";
import { callerAllowed, jwtRole } from "./auth.ts";

const FIXED_NOW = new Date("2026-09-13T00:00:00Z");

// ---------------------------------------------------------------------------
// Polygon: URL construction
// ---------------------------------------------------------------------------

Deno.test("aggsUrl: full range asks for ~2 years of DAY bars, split-adjusted", () => {
  const u = aggsUrl("MU", "full", FIXED_NOW);
  assertEquals(u.includes("/range/1/day/"), true);
  assertEquals(u.includes("adjusted=true"), true);
  assertEquals(u.includes("sort=asc"), true);
  // 720 days before 2026-09-13, and `to` is tomorrow so today's bar is in the window.
  assertEquals(u.includes("/2024-09-23/2026-09-14"), true);
  assertEquals(u.includes("apiKey"), false, "the key goes in a header, never the URL");
});

Deno.test("aggsUrl: incremental asks for ~5 weeks, enough to cover missed runs", () => {
  const u = aggsUrl("MU", "incremental", FIXED_NOW);
  assertEquals(u.includes("/2026-08-09/2026-09-14"), true);
});

Deno.test("aggsUrl percent-encodes the symbol", () => {
  assertEquals(aggsUrl("BRK.B", "incremental", FIXED_NOW).includes("/ticker/BRK.B/"), true);
});

// ---------------------------------------------------------------------------
// Polygon: the trading-date conversion, across both DST offsets
// ---------------------------------------------------------------------------

Deno.test("aggTradingDate: EST bar (midnight ET = 05:00Z) maps to the same calendar day", () => {
  // 2026-01-15 00:00 America/New_York = 2026-01-15T05:00:00Z
  assertEquals(aggTradingDate(Date.UTC(2026, 0, 15, 5, 0, 0)), "2026-01-15");
});

Deno.test("aggTradingDate: EDT bar (midnight ET = 04:00Z) maps to the same calendar day", () => {
  // 2026-07-15 00:00 America/New_York = 2026-07-15T04:00:00Z
  assertEquals(aggTradingDate(Date.UTC(2026, 6, 15, 4, 0, 0)), "2026-07-15");
});

// ---------------------------------------------------------------------------
// Polygon: response mapping
// ---------------------------------------------------------------------------

const AGGS_OK = {
  ticker: "MU",
  adjusted: true,
  status: "OK",
  resultsCount: 3,
  results: [
    { t: Date.UTC(2026, 6, 13, 4), o: 120, h: 125, l: 119, c: 124, v: 1_000_000 },
    { t: Date.UTC(2026, 6, 14, 4), o: 121.5, h: 123, l: 120, c: 122 }, // no volume
    { t: Date.UTC(2026, 6, 15, 4), o: 122, h: 124, l: 121 }, // no close -> dropped
  ],
};

Deno.test("mapAggs keeps bars with a close and drops the one without", () => {
  const bars = mapAggs(AGGS_OK, "MU");
  assertEquals(bars.length, 2);
  assertEquals(bars[0], {
    symbol: "MU",
    d: "2026-07-13",
    open: 120,
    high: 125,
    low: 119,
    close: 124,
    adj_close: null,
    volume: 1_000_000,
    source: POLYGON_SOURCE,
  });
  assertEquals(bars[1].volume, null, "a missing volume stays null, not zero");
});

Deno.test("mapAggs never fills adj_close from close - Polygon is split-adjusted only", () => {
  for (const b of mapAggs(AGGS_OK, "MU")) assertEquals(b.adj_close, null);
});

Deno.test("mapAggs treats results:null as zero bars, not an error", () => {
  assertEquals(mapAggs({ status: "OK", results: null }, "THIN"), []);
});

Deno.test("mapAggs throws on an error body arriving with HTTP 200", () => {
  assertThrows(
    () => mapAggs({ status: "ERROR", error: "unknown ticker ZZZZ" }, "ZZZZ"),
    "unknown ticker",
  );
});

Deno.test("mapAggs throws on a non-OK status - how a plan restriction arrives", () => {
  assertThrows(() => mapAggs({ status: "NOT_AUTHORIZED", results: [] }, "MU"), "NOT_AUTHORIZED");
});

Deno.test("mapAggs accepts DELAYED, which is what the free plan returns", () => {
  assertEquals(mapAggs({ status: "DELAYED", results: [] }, "MU"), []);
});

// ---------------------------------------------------------------------------
// FRED
// ---------------------------------------------------------------------------

Deno.test("SERIES maps exactly the three index symbols the watchlist keeps", () => {
  assertEquals(Object.keys(SERIES).sort(), ["^GSPC", "^VIX", "^VIX3M"]);
  assertEquals(SERIES["^VIX"], "VIXCLS");
  assertEquals(SERIES["^VIX3M"], "VXVCLS");
  assertEquals(SERIES["^GSPC"], "SP500");
});

Deno.test("observationsUrl asks for json and an explicit start, and omits the key", () => {
  const u = observationsUrl("VIXCLS", "incremental", FIXED_NOW);
  assertEquals(u.includes("series_id=VIXCLS"), true);
  assertEquals(u.includes("file_type=json"), true);
  assertEquals(u.includes("observation_start=2026-08-09"), true);
  assertEquals(u.includes("api_key"), false, "the key is appended by the caller only");
});

const OBS_OK = {
  observations: [
    { date: "2026-09-08", value: "15.42" },
    { date: "2026-09-09", value: "." }, // no observation - holiday or unpublished
    { date: "2026-09-10", value: "19.73" },
    { date: "2026-09-11", value: "not-a-number" },
  ],
};

Deno.test("mapObservations drops '.' rows rather than inventing a close", () => {
  const bars = mapObservations(OBS_OK, "^VIX", "VIXCLS");
  assertEquals(bars.map((b) => b.d), ["2026-09-08", "2026-09-10"]);
  assertEquals(bars.map((b) => b.close), [15.42, 19.73]);
});

Deno.test("mapObservations leaves OHLC and volume null - FRED publishes a close only", () => {
  const b = mapObservations(OBS_OK, "^VIX", "VIXCLS")[0];
  assertEquals([b.open, b.high, b.low, b.volume, b.adj_close], [null, null, null, null, null]);
  assertEquals(b.source, FRED_SOURCE);
});

Deno.test("mapObservations throws on FRED's error body", () => {
  assertThrows(
    () => mapObservations({ error_message: "Bad Request. The value for variable api_key is not registered." }, "^VIX", "VIXCLS"),
    "api_key",
  );
});

// ---------------------------------------------------------------------------
// Routing: must be exhaustive AND disjoint, or a symbol silently gets no data
// ---------------------------------------------------------------------------

Deno.test("FRED claims the index symbols and Polygon declines them", () => {
  for (const s of ["^VIX", "^VIX3M", "^GSPC"]) {
    assertEquals(fred.supports(s), true, `fred should serve ${s}`);
    assertEquals(polygon.supports(s), false, `polygon should decline ${s}`);
  }
});

Deno.test("Polygon claims the equities and FRED declines them", () => {
  for (const s of ["MU", "NVDA", "JPM", "SNDK"]) {
    assertEquals(polygon.supports(s), true, `polygon should serve ${s}`);
    assertEquals(fred.supports(s), false, `fred should decline ${s}`);
  }
});

Deno.test("an index with no FRED series is claimed by nobody, so sync fails loudly", () => {
  // ^SOX was dropped in decision 0019. If it ever comes back without a source, syncTickers
  // must refuse rather than leave a column quietly empty.
  assertEquals(fred.supports("^SOX"), false);
  assertEquals(polygon.supports("^SOX"), false);
});

Deno.test("neither provider serves hourly yet, and says so with null not []", async () => {
  assertEquals(await polygon.hourly("MU", "full"), null);
  assertEquals(await fred.hourly("^VIX", "full"), null);
});

Deno.test("pacing comes from the provider, derived from its published limit", () => {
  // Polygon free is 5 req/min; anything under 12000ms would exceed it.
  assertEquals(polygon.minIntervalMs >= 12_000, true);
  // FRED allows 120/min; being slower than Polygon would be pointless.
  assertEquals(fred.minIntervalMs < polygon.minIntervalMs, true);
});

// ---------------------------------------------------------------------------
// Rate limiting
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

Deno.test("a 429 raises RateLimitError - the caller must stop the run, not skip a symbol", async () => {
  Deno.env.set("POLYGON_API_KEY", "test-key");
  let caught: unknown = null;
  try {
    await withFetch("rate limit exceeded", () => polygon.daily("MU", "incremental"), 429);
  } catch (e) {
    caught = e;
  }
  assertEquals(caught instanceof RateLimitError, true);
});

Deno.test("a rejected key is a plain error, distinguishable from a rate limit", async () => {
  Deno.env.set("POLYGON_API_KEY", "test-key");
  let caught: unknown = null;
  try {
    await withFetch({ error: "unauthorized" }, () => polygon.daily("MU", "incremental"), 401);
  } catch (e) {
    caught = e;
  }
  assertEquals(caught instanceof Error, true);
  assertEquals(caught instanceof RateLimitError, false);
  assertEquals((caught as Error).message.includes("key rejected"), true);
});

Deno.test("a missing key fails before any request is made", async () => {
  Deno.env.delete("POLYGON_API_KEY");
  let caught: unknown = null;
  try {
    await polygon.daily("MU", "incremental");
  } catch (e) {
    caught = e;
  }
  assertEquals((caught as Error).message.includes("POLYGON_API_KEY"), true);
});

// ---------------------------------------------------------------------------
// parseWatchlist
// ---------------------------------------------------------------------------

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

Deno.test("parseWatchlist: rankable comes from the theme, indices are flagged and unrankable", () => {
  const rows = parseWatchlist(WATCHLIST_YML);
  const by = Object.fromEntries(rows.map((r) => [r.symbol, r]));
  assertEquals(rows.length, 3);
  assertEquals(by.MU.rankable, true);
  assertEquals(by.MU.bellwether, true);
  assertEquals(by.JPM.rankable, false, "diversified is rankable: false in the yml");
  assertEquals(by.JPM.tag, null);
  assertEquals(by["^VIX"].is_index, true);
  assertEquals(by["^VIX"].rankable, false);
  assertEquals(by["^VIX"].theme, "index");
});

Deno.test("parseWatchlist rejects an undeclared theme instead of defaulting", () => {
  const bad = WATCHLIST_YML.replace("theme: diversified", "theme: diversifed");
  assertThrows(() => parseWatchlist(bad), "undeclared theme");
});

Deno.test("parseWatchlist rejects a duplicate symbol", () => {
  const bad = WATCHLIST_YML + `  - { symbol: MU, name: dup }\n`;
  assertThrows(() => parseWatchlist(bad), "duplicate symbol");
});

// ---------------------------------------------------------------------------
// auth - unsigned test JWTs; the gateway is what verifies signatures in production
// ---------------------------------------------------------------------------

function fakeJwt(payload: Record<string, unknown>): string {
  const b64url = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.sig`;
}
const SERVICE = fakeJwt({ iss: "supabase", role: "service_role", exp: 2_000_000_000 });
const ANON = fakeJwt({ iss: "supabase", role: "anon", exp: 2_000_000_000 });

Deno.test("jwtRole reads the role claim and returns null for non-JWTs", () => {
  assertEquals(jwtRole(SERVICE), "service_role");
  assertEquals(jwtRole(ANON), "anon");
  assertEquals(jwtRole("sb_secret_notajwt"), null);
  assertEquals(jwtRole("a.b"), null);
});

Deno.test("callerAllowed: service_role JWT passes even when it differs from the env var", () => {
  assertEquals(callerAllowed(SERVICE, "some-other-runtime-value"), true);
  assertEquals(callerAllowed(SERVICE, undefined), true);
});

Deno.test("callerAllowed: anon JWT is refused, with or without an env var", () => {
  assertEquals(callerAllowed(ANON, "some-other-runtime-value"), false);
  assertEquals(callerAllowed(ANON, undefined), false);
});

Deno.test("callerAllowed: exact byte match with the env var passes (non-JWT key formats)", () => {
  assertEquals(callerAllowed("sb_secret_abc", "sb_secret_abc"), true);
  assertEquals(callerAllowed("sb_secret_abc", "sb_secret_abd"), false);
  assertEquals(callerAllowed("sb_secret_ab", "sb_secret_abc"), false);
});

Deno.test("callerAllowed: no token is refused", () => {
  assertEquals(callerAllowed(null, "anything"), false);
});
