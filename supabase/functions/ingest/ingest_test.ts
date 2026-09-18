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

import { isScope, planLimit, RateLimitError, SCOPES, universeFor } from "./provider.ts";
import { aggsUrl, aggTradingDate, mapAggs, polygon, POLYGON_SOURCE } from "./polygon.ts";
import { fred, FRED_SOURCE, mapObservations, observationsUrl, SERIES } from "./fred.ts";
import {
  DEFAULT_ATTEMPTS,
  DEFAULT_DELAYS_MS,
  fetchWithRetry,
  type RetryInfo,
} from "./http.ts";
import { parseWatchlist } from "./watchlist.ts";
import { parseNorms } from "./norms.ts";
import { callerAllowed, jwtRole } from "../_shared/auth.ts";

const FIXED_NOW = new Date("2026-09-13T00:00:00Z");

// ---------------------------------------------------------------------------
// Polygon: URL construction
// ---------------------------------------------------------------------------

Deno.test("aggsUrl: full range asks for ~5 years of DAY bars, split-adjusted", () => {
  const u = aggsUrl("MU", "full", FIXED_NOW);
  assertEquals(u.includes("/range/1/day/"), true);
  assertEquals(u.includes("adjusted=true"), true);
  assertEquals(u.includes("sort=asc"), true);
  // 1800 days before 2026-09-13, and `to` is tomorrow so today's bar is in the window.
  // Pinned as a literal date rather than recomputed: the point of this test is to catch the
  // window silently changing, and a test that recomputes the expected value cannot do that.
  assertEquals(u.includes("/2021-10-09/2026-09-14"), true);
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

Deno.test("mapAggs rounds volume to an integer - Polygon returns it as a float", () => {
  // The real value that broke the first live run: MU came back with v: 25426639.075335 and
  // `daily_bars.volume` is bigint, so PostgreSQL rejected the entire batch.
  // INCIDENTS.md 2026-09-13.
  const frac = {
    status: "OK",
    results: [{ t: Date.UTC(2026, 6, 13, 4), c: 124, v: 25426639.075335 }],
  };
  const b = mapAggs(frac, "MU")[0];
  assertEquals(b.volume, 25426639);
  assertEquals(Number.isInteger(b.volume), true, "a float here rejects the whole upsert batch");
});

Deno.test("mapAggs keeps a null volume null rather than rounding it to zero", () => {
  const none = { status: "OK", results: [{ t: Date.UTC(2026, 6, 13, 4), c: 124 }] };
  assertEquals(mapAggs(none, "MU")[0].volume, null);
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

Deno.test("mapAggs accepts DELAYED, which is what a 15-minute-delayed plan returns", () => {
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

Deno.test("pacing comes from the provider, and no provider paces at zero", () => {
  // Each provider is checked against its OWN published limit. The previous version of this test
  // asserted fred.minIntervalMs < polygon.minIntervalMs, which was true only because Polygon's
  // free tier was the slowest thing in the system. On Starter that ordering inverts, and a test
  // that encodes an accident fails for the wrong reason.
  //
  // Polygon Starter publishes unlimited calls, so the only requirement is that we are not
  // hammering: a floor, not a ceiling. 90 requests in 6.9 s is what killed the Yahoo pipeline.
  assertEquals(polygon.minIntervalMs >= 100, true, "never pace Polygon faster than 10/second");
  // FRED publishes 120 requests/minute, i.e. 500ms; we sit well above it out of courtesy.
  assertEquals(fred.minIntervalMs >= 500, true, "FRED's published limit is 120/min");
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
// Vendor fetch retry (http.ts)
//
// Closes the gap recorded in CONSTRAINTS.md on 2026-09-15: Supabase reads were retried, vendor
// fetches were not, so one transient 502 lost that symbol until the next night.
//
// Which of these fail against the code as it was before http.ts existed, and which are guards that
// passed then and must keep passing - stated because the difference is the whole value of the set:
//
//   NEW BEHAVIOUR (all failed before): a 502 then a 200 succeeds; a transport error then a 200
//   succeeds; a persistent 5xx gives up after exactly DEFAULT_ATTEMPTS; the pause schedule is the
//   documented one; the deadline refuses an attempt that cannot finish in time.
//
//   MUST NOT CHANGE (passed before, and would still pass if the policy were wrong in the most
//   tempting way): 4xx is never retried, 429 is never retried and still becomes a RateLimitError,
//   and a 200 carrying an error body is never retried.
// ---------------------------------------------------------------------------

/** Each entry is the outcome of one call: a Response to return, or an Error to throw. */
function withFetchSequence<T>(
  outcomes: Array<Response | Error>,
  fn: (calls: () => number) => Promise<T>,
): Promise<T> {
  const real = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (() => {
    const o = outcomes[Math.min(n, outcomes.length - 1)];
    n++;
    return o instanceof Error ? Promise.reject(o) : Promise.resolve(o.clone());
  }) as typeof fetch;
  return fn(() => n).finally(() => {
    globalThis.fetch = real;
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const OK_AGGS = { status: "OK", results: [{ t: 1757649600000, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }] };

/** Records the pauses instead of taking them, so the schedule is asserted rather than waited for. */
function fakeSleep() {
  const slept: number[] = [];
  return { slept, sleep: (ms: number) => { slept.push(ms); return Promise.resolve(); } };
}

Deno.test("a 502 is retried and the next attempt's bars are used", async () => {
  Deno.env.set("POLYGON_API_KEY", "test-key");
  const { slept, sleep } = fakeSleep();
  const r = await withFetchSequence(
    [json({ error: "bad gateway" }, 502), json(OK_AGGS)],
    async (calls) => {
      const res = await fetchWithRetry("https://example.test/aggs", {}, { sleep, onRetry: () => {} });
      assertEquals(calls(), 2, "the 502 must be asked again");
      return res;
    },
  );
  assertEquals(r.status, 200);
  assertEquals(slept, [DEFAULT_DELAYS_MS[0]], "one pause, the documented first delay");
});

Deno.test("a transport failure is retried - a dropped connection says nothing about the request", async () => {
  const { sleep } = fakeSleep();
  await withFetchSequence(
    [new TypeError("error sending request: connection reset by peer"), json(OK_AGGS)],
    async (calls) => {
      const res = await fetchWithRetry("https://example.test/aggs", {}, { sleep, onRetry: () => {} });
      assertEquals(res.status, 200);
      assertEquals(calls(), 2);
    },
  );
});

Deno.test("a persistent 5xx gives up after exactly DEFAULT_ATTEMPTS, on the documented schedule", async () => {
  const { slept, sleep } = fakeSleep();
  const reasons: RetryInfo[] = [];
  await withFetchSequence([json({ error: "upstream" }, 503)], async (calls) => {
    let caught: unknown = null;
    try {
      await fetchWithRetry("https://example.test/aggs", {}, {
        sleep,
        onRetry: (i) => reasons.push(i),
      });
    } catch (e) {
      caught = e;
    }
    assertEquals(caught instanceof Error, true);
    assertEquals((caught as Error).message.includes("503"), true, "the last failure is what surfaces");
    assertEquals(calls(), DEFAULT_ATTEMPTS);
  });
  assertEquals(slept, DEFAULT_DELAYS_MS, "pauses grow, and there is one fewer than attempts");
  assertEquals(reasons.map((r) => r.reason), ["server", "server"]);
  assertEquals(reasons.map((r) => r.status), [503, 503]);
});

Deno.test("4xx is NEVER retried - a wrong question does not become right on the second ask", async () => {
  Deno.env.set("POLYGON_API_KEY", "test-key");
  await withFetchSequence([json({ error: "unauthorized" }, 401)], async (calls) => {
    let caught: unknown = null;
    try {
      await polygon.daily("MU", "incremental");
    } catch (e) {
      caught = e;
    }
    assertEquals((caught as Error).message.includes("key rejected"), true);
    assertEquals(calls(), 1, "one call, or a bad key costs three times as long to report");
  });
});

Deno.test("429 is NEVER retried and still aborts the run - retrying a rate limit is how Yahoo blocked us", async () => {
  Deno.env.set("POLYGON_API_KEY", "test-key");
  await withFetchSequence([new Response("slow down", { status: 429 })], async (calls) => {
    let caught: unknown = null;
    try {
      await polygon.daily("MU", "incremental");
    } catch (e) {
      caught = e;
    }
    assertEquals(caught instanceof RateLimitError, true);
    assertEquals(calls(), 1);
  });
});

Deno.test("an error body arriving with HTTP 200 is not retried - it is an answer, not a fault", async () => {
  Deno.env.set("POLYGON_API_KEY", "test-key");
  await withFetchSequence([json({ status: "NOT_AUTHORIZED", results: null })], async (calls) => {
    let caught: unknown = null;
    try {
      await polygon.daily("MU", "incremental");
    } catch (e) {
      caught = e;
    }
    assertEquals((caught as Error).message.includes("NOT_AUTHORIZED"), true);
    assertEquals(calls(), 1);
  });
});

Deno.test("the deadline refuses an attempt that could not finish in time", async () => {
  // Every attempt "takes" the full per-attempt timeout. With a 45 s deadline the third attempt
  // would end at 61 s, so it is never started - the policy the header describes.
  let clock = 0;
  const { sleep } = fakeSleep();
  const infos: RetryInfo[] = [];
  await withFetchSequence(
    [new DOMException("Signal timed out.", "TimeoutError")],
    async (calls) => {
      let caught: unknown = null;
      try {
        await fetchWithRetry("https://example.test/aggs", {}, {
          sleep: (ms) => { clock += ms; return sleep(ms); },
          now: () => { const t = clock; clock += 20_000; return t; },
          onRetry: (i) => infos.push(i),
        });
      } catch (e) {
        caught = e;
      }
      assertEquals(caught instanceof Error, true);
      assertEquals(calls(), 2, "two attempts, not three - the third cannot fit the deadline");
    },
  );
  assertEquals(infos.length, 2);
  assertEquals(infos[1].detail.includes("no time left"), true, "and it says why it stopped");
});

Deno.test("FRED's retry label carries the series id and never the url, which holds the api key", async () => {
  Deno.env.set("FRED_API_KEY", "secret-key-value");
  const labels: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => { labels.push(a.map(String).join(" ")); };
  try {
    await withFetchSequence(
      [json({ error_message: "x" }, 500), json({ observations: [] })],
      async () => {
        // Default onRetry logs; the point of this test is what that line contains.
        await fred.daily("^VIX", "incremental");
      },
    );
  } finally {
    console.warn = realWarn;
  }
  assertEquals(labels.length, 1);
  assertEquals(labels[0].includes("VIXCLS"), true);
  assertEquals(labels[0].includes("secret-key-value"), false, "a retry log must never print the key");
});

// ---------------------------------------------------------------------------
// parseWatchlist
// ---------------------------------------------------------------------------

const WATCHLIST_YML = `
themes:
  memory-storage: { label: "Memory", rankable: true }
  diversified:    { label: "Diversified", rankable: false }
  etfs:           { label: "ETFs", rankable: false }
tickers:
  - { symbol: MU,  name: Micron, theme: memory-storage, tag: hbm, bellwether: true }
  - { symbol: JPM, name: JPMorgan, theme: diversified }
  - { symbol: SPY, name: SPDR S&P 500, theme: etfs, fund: true }
indices:
  - { symbol: "^VIX", name: VIX }
`;

Deno.test("parseWatchlist: rankable comes from the theme, indices are flagged and unrankable", () => {
  const rows = parseWatchlist(WATCHLIST_YML);
  const by = Object.fromEntries(rows.map((r) => [r.symbol, r]));
  // 2 companies + 1 fund + 1 index. The fund counts as a row; the index is a row in `tickers`
  // but never on the grid - see the is_fund/is_index test below.
  assertEquals(rows.length, 4);
  assertEquals(by.MU.rankable, true);
  assertEquals(by.MU.bellwether, true);
  assertEquals(by.JPM.rankable, false, "diversified is rankable: false in the yml");
  assertEquals(by.JPM.tag, null);
  assertEquals(by["^VIX"].is_index, true);
  assertEquals(by["^VIX"].rankable, false);
  assertEquals(by["^VIX"].theme, "index");
});

Deno.test("parseWatchlist: a fund is a ROW, an index is not - two different exclusions", () => {
  const rows = parseWatchlist(WATCHLIST_YML);
  const spy = rows.find((r) => r.symbol === "SPY")!;
  const vix = rows.find((r) => r.symbol === "^VIX")!;
  const mu = rows.find((r) => r.symbol === "MU")!;

  // The whole point of the second flag: SPY is on the grid, ^VIX never is.
  assertEquals([spy.is_fund, spy.is_index], [true, false]);
  assertEquals([vix.is_fund, vix.is_index], [false, true]);
  assertEquals([mu.is_fund, mu.is_index], [false, false]);

  // A fund keeps a real theme and a real name - it is not a degenerate index row.
  assertEquals(spy.theme, "etfs");
  assertEquals(spy.rankable, false, "etfs theme is rankable: false - there is nothing to rank");
});

Deno.test("parseWatchlist reads `fund` per ENTRY, not from the theme name", () => {
  // A fund filed under a non-etfs theme must still be a fund. Deriving is_fund from
  // `theme === "etfs"` passes the test above and fails this one.
  const yml = `
themes:
  diversified: { label: "Diversified", rankable: false }
tickers:
  - { symbol: XLE, name: Energy Select, theme: diversified, fund: true }
  - { symbol: XOM, name: Exxon, theme: diversified }
`;
  const rows = parseWatchlist(yml);
  assertEquals(rows.find((r) => r.symbol === "XLE")!.is_fund, true);
  assertEquals(rows.find((r) => r.symbol === "XOM")!.is_fund, false);
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

// ---------------------------------------------------------------------------
// Per-run caps. The rate limit stopped being the constraint on 2026-09-13; the 150 s wall clock
// and the payload size are. These pin that a full backfill defaults LOWER than a top-up.
// ---------------------------------------------------------------------------

Deno.test("planLimit: a full backfill defaults lower than a routine top-up", () => {
  const full = planLimit(true, null);
  const incremental = planLimit(false, null);
  assertEquals(full < incremental, true, "a full run costs ~50x the payload of a top-up");
  // The whole watchlist (39 symbols today) must fit one incremental run, or a routine refresh
  // silently needs a second call that nothing is scheduled to make.
  assertEquals(incremental >= 39, true);
});

Deno.test("the VIX band drawn on the chart is the norm in config/norms.yml", async () => {
  // A DUPLICATED THRESHOLD, PINNED RATHER THAN TRUSTED.
  //
  // `config/norms.yml` decides whether the VIX tile is coloured. `web/lib/market-history.ts` also
  // carries 16 and 30, because the market-history chart has to DRAW the band and the page does not
  // fetch norms for the market block. That is a second copy of a threshold, which is precisely the
  // thing this repo keeps getting bitten by - three norms have already judged nothing because a
  // name or a number drifted (pct_off_ath, rs_vs_spx_6m, vix_term_struct).
  //
  // So the copy is allowed and asserted. Retune the norm without touching the chart and this fails
  // here, rather than the dashboard quietly drawing last month's band across this month's data.
  //
  // Read as TEXT, not imported: web/ is a Next app with its own module resolution, and pulling a
  // .ts file out of it into Deno would couple two toolchains to make one comparison.
  const src = await Deno.readTextFile(
    new URL("../../../web/lib/market-history.ts", import.meta.url),
  );
  const m = src.match(/export const VIX_BAND = \{\s*low:\s*(-?[\d.]+),\s*high:\s*(-?[\d.]+)\s*\}/);
  assert(m, "could not find VIX_BAND in web/lib/market-history.ts - was it renamed?");
  const chart = { low: Number(m![1]), high: Number(m![2]) };

  const yml = await Deno.readTextFile(new URL("../../../config/norms.yml", import.meta.url));
  const norm = parseNorms(yml).norms.find((n) => n.param === "vix");
  assert(norm, "config/norms.yml has no vix norm, but the chart draws a band for it");

  assertEquals(
    chart,
    { low: norm!.low, high: norm!.high },
    "VIX_BAND in web/lib/market-history.ts has drifted from the vix norm in config/norms.yml",
  );
});

Deno.test("planLimit: the routine cap covers the whole watchlist, indices included", async () => {
  // THE CHECK THAT DID NOT EXIST ON 2026-09-18. `DEFAULT_LIMIT_INCREMENTAL` was 45 while the
  // watchlist held 53 tickers plus three index series, so every nightly run silently dropped the
  // alphabetical tail - the same eleven names, one day further behind each night, with the run
  // reporting success. Nothing compared the constant to the config.
  //
  // Reading the yml from disk rather than hardcoding a number is the point: a count typed in here
  // would go stale the moment the watchlist changed, which is the failure being guarded against.
  //
  // The watchlist ALREADY CONTAINS the three index series, so they are not added on top. The first
  // version of this test did add them and reported a universe of 59 against a real 56. The
  // assertion still held - it was merely stricter than the truth - but the number was in the
  // failure message, and a check that misreports the thing it is measuring teaches the next reader
  // the wrong number. Asserted below rather than assumed, so a future yml that drops the indices
  // makes this fail here instead of silently under-counting.
  const yml = await Deno.readTextFile(new URL("../../../config/watchlist.yml", import.meta.url));
  const symbols = parseWatchlist(yml).map((r) => r.symbol);
  for (const s of Object.keys(SERIES)) {
    assert(symbols.includes(s), `${s} is in SERIES but not in config/watchlist.yml`);
  }
  const universe = symbols.length;
  const cap = planLimit(false, null);
  assert(
    cap >= universe,
    `the per-run cap is ${cap} but one run must fetch ${universe} symbols ` +
      `(config/watchlist.yml, indices included). Raise DEFAULT_LIMIT_INCREMENTAL in provider.ts. ` +
      `A cap below the universe does not sample it - activeSymbols orders by symbol, so it ` +
      `starves a fixed alphabetical tail every run, the same names each night.`,
  );
});

Deno.test("planLimit: an explicit limit always wins, and junk falls back", () => {
  assertEquals(planLimit(true, "7"), 7);
  assertEquals(planLimit(false, "7"), 7);
  assertEquals(planLimit(true, ""), planLimit(true, null), "empty is not a limit of zero");
  assertEquals(planLimit(true, "0"), planLimit(true, null), "zero would fetch nothing forever");
  assertEquals(planLimit(true, "-5"), planLimit(true, null));
  assertEquals(planLimit(true, "abc"), planLimit(true, null));
});

// ---------------------------------------------------------------------------
// Norms. These decide what gets coloured, so a parse that silently drops or mangles one is the
// difference between "no opinion" and "we checked and it is fine" on the dashboard.
// ---------------------------------------------------------------------------

const NORMS_YML = `
norms:
  rsi_daily:           { low: 30, high: 70 }
  pct_off_high_stored: { low: -30 }
  net_debt_ebitda:     { high: 4 }
flags:
  stale_days_price: 3
  min_bars_warning: true
`;

Deno.test("parseNorms keeps one-sided bounds as one-sided", () => {
  const { norms } = parseNorms(NORMS_YML);
  const by = Object.fromEntries(norms.map((n) => [n.param, n]));
  assertEquals(by["rsi_daily"].low, 30);
  assertEquals(by["rsi_daily"].high, 70);
  // A low-only norm must NOT acquire a high. "% off the high" has no upper state to be in, and
  // inventing one would paint every name above -30 as though we had judged the other end too.
  assertEquals(by["pct_off_high_stored"].low, -30);
  assertEquals(by["pct_off_high_stored"].high, null);
  // A veto is high-only for the same reason in reverse.
  assertEquals(by["net_debt_ebitda"].low, null);
  assertEquals(by["net_debt_ebitda"].high, 4);
});

Deno.test("parseNorms keeps flags separate from norms, with their types intact", () => {
  const { norms, flags } = parseNorms(NORMS_YML);
  assertEquals(norms.some((n) => n.param === "stale_days_price"), false, "a flag is not a norm");
  const by = Object.fromEntries(flags.map((f) => [f.key, f.value]));
  assertEquals(by["stale_days_price"], 3);
  assertEquals(by["min_bars_warning"], true, "a boolean flag must not become a string");
});

Deno.test("parseNorms refuses an empty norms block rather than wiping every verdict", () => {
  // The sync DELETES norms missing from the yml, so an empty parse would blank the whole grid.
  // A truncated download and a deliberate removal look identical; treat it as the broken file.
  assert.throws(() => parseNorms("norms:\nflags:\n  stale_days_price: 3\n"));
  assert.throws(() => parseNorms("flags:\n  stale_days_price: 3\n"));
});

Deno.test("parseNorms rejects a norm that could never colour anything", () => {
  assert.throws(() => parseNorms("norms:\n  rsi_daily: { }\n"), /neither low nor high/);
});

Deno.test("parseNorms rejects an inverted band instead of silently never matching", () => {
  // low >= high means no value can ever be 'normal'; every cell would read as an extreme.
  assert.throws(() => parseNorms("norms:\n  rsi_daily: { low: 70, high: 30 }\n"));
  assert.throws(() => parseNorms("norms:\n  rsi_daily: { low: 50, high: 50 }\n"));
});

Deno.test("parseNorms skips a commented-out norm without failing the whole file", () => {
  // A norm commented out in yml parses as null. That is a removal, not a syntax error - and
  // removing one norm must not take the other fifteen down with it.
  const { norms } = parseNorms("norms:\n  rsi_daily: { low: 30, high: 70 }\n  rs_vs_sox_6m:\n");
  assertEquals(norms.length, 1);
  assertEquals(norms[0].param, "rsi_daily");
});

// ---------------------------------------------------------------------------
// Scope routing. Added 2026-09-15 with the `indices` scope.
//
// Worth testing rather than eyeballing because every failure here is silent: a scope that resolves
// to the wrong universe fetches the wrong symbols and still reports success, and a scope missing
// from the validator is a 400 on a cron job nobody is watching at 11:00 UTC.
// ---------------------------------------------------------------------------

Deno.test("every scope resolves to a universe, or explicitly to none", () => {
  // The point is exhaustiveness: a scope added later without a universeFor() case would return
  // undefined and `activeSymbols` would silently fetch everything.
  for (const scope of SCOPES) {
    const u = universeFor(scope);
    assertEquals(
      u === null || u === "all" || u === "equities" || u === "indices",
      true,
      `scope ${scope} resolved to ${String(u)}`,
    );
  }
});

Deno.test("indices is index-only, and is NOT reachable through `all`", () => {
  // If `all` also routed to "indices" the evening run would stop fetching equities entirely; if
  // `indices` routed to "all" the morning catch-up would re-fetch 36 equities for nothing.
  assertEquals(universeFor("indices"), "indices");
  assertEquals(universeFor("all"), "all");
  assertEquals(universeFor("daily"), "all", "daily still carries the index series");
});

Deno.test("hourly excludes indices, because FRED has no intraday series to ask for", () => {
  assertEquals(universeFor("hourly"), "equities");
});

Deno.test("the ticker sync does no bar work", () => {
  assertEquals(universeFor("tickers"), null);
});

Deno.test("the validator accepts exactly the scopes that exist, and nothing else", () => {
  for (const scope of SCOPES) assertEquals(isScope(scope), true, scope);
  for (const bad of ["", "index", "indice", "Daily", "all ", "weekly", "1"]) {
    assertEquals(isScope(bad), false, `"${bad}" must be rejected`);
  }
});

