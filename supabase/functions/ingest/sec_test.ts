/**
 * sec_test.ts — the pure parts of the EDGAR ingest, pinned.
 *
 * The fixtures are hand-built in the SHAPE SEC returns (checked against real responses on
 * 2026-09-27), with invented numbers. SEC filings are public domain, but invented numbers keep the
 * tests about structure: nothing here should pass because a real value happened to line up.
 */
import assert from "node:assert/strict";
import {
  companyFactsUrl,
  extractFacts,
  latestPeriodic,
  mapCompanyTickers,
  isBankSic,
  pad10,
  parseSic,
  submissionsUrl,
  validUserAgent,
} from "./sec.ts";

// ---------------------------------------------------------------------------- URLs and UA

Deno.test("CIKs are zero-padded to ten digits in both document URLs", () => {
  assert.equal(pad10(723125), "0000723125");
  assert.equal(submissionsUrl(723125), "https://data.sec.gov/submissions/CIK0000723125.json");
  assert.equal(companyFactsUrl(6951), "https://data.sec.gov/api/xbrl/companyfacts/CIK0000006951.json");
});

Deno.test("the User-Agent must name someone and carry an email, and the placeholder is refused", () => {
  assert.ok(validUserAgent("Jane Doe jane@example.com"));
  assert.ok(validUserAgent("SwingTracker jane.doe+sec@mail.example.org"));
  assert.ok(!validUserAgent(undefined));
  assert.ok(!validUserAgent(""));
  assert.ok(!validUserAgent("jane@example.com"), "no name");
  assert.ok(!validUserAgent("Jane Doe"), "no email");
  // The exact placeholder handed to Bodhi on 2026-09-27; the first probe that carried a placeholder
  // got SEC's 403 rate-limit page.
  assert.ok(!validUserAgent("YOUR_NAME YOUR_EMAIL"));
  assert.ok(!validUserAgent("SwingTracker YOUR_EMAIL"));
});

// ---------------------------------------------------------------------------- tickers

Deno.test("mapCompanyTickers maps the symbols asked for and nothing else", () => {
  const file = {
    "0": { cik_str: 1045810, ticker: "NVDA", title: "NVIDIA CORP" },
    "1": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
    "2": { cik_str: 1067983, ticker: "BRK-B", title: "BERKSHIRE HATHAWAY INC" },
    "3": { cik_str: 999, ticker: "AAPL", title: "a later duplicate that must not win" },
  };
  assert.deepEqual(mapCompanyTickers(file, ["AAPL", "BRK.B", "ZZZZ"]), { AAPL: 320193, "BRK.B": 1067983 });
});

Deno.test("mapCompanyTickers refuses a document that is not the ticker file", () => {
  assert.throws(() => mapCompanyTickers(null, ["AAPL"]), /not an object/);
});

// ---------------------------------------------------------------------------- submissions

Deno.test("latestPeriodic picks the newest 10-Q/10-K/20-F and ignores 8-Ks and Form 4s", () => {
  const sub = {
    filings: {
      recent: {
        accessionNumber: ["a-8k", "a-4", "a-10q", "a-10k"],
        form: ["8-K", "4", "10-Q", "10-K"],
        filingDate: ["2026-09-20", "2026-09-19", "2026-07-01", "2025-10-15"],
      },
    },
  };
  assert.deepEqual(latestPeriodic(sub), { accn: "a-10q", form: "10-Q", filed: "2026-07-01" });
});

Deno.test("a 6-K never triggers a re-fetch; a 20-F does", () => {
  // ASML files 6-Ks for buyback updates most weeks; none carry statement facts.
  const sub = {
    filings: {
      recent: {
        accessionNumber: ["six", "twenty"],
        form: ["6-K", "20-F"],
        filingDate: ["2026-09-20", "2026-02-10"],
      },
    },
  };
  assert.equal(latestPeriodic(sub)?.accn, "twenty");
});

Deno.test("latestPeriodic ranks by date, not by position", () => {
  const sub = {
    filings: { recent: { accessionNumber: ["old", "new"], form: ["10-Q", "10-K"], filingDate: ["2025-01-01", "2026-01-01"] } },
  };
  assert.equal(latestPeriodic(sub)?.accn, "new");
});

Deno.test("latestPeriodic: none in the window is null; a malformed document throws", () => {
  const sub = { filings: { recent: { accessionNumber: ["x"], form: ["8-K"], filingDate: ["2026-01-01"] } } };
  assert.equal(latestPeriodic(sub), null);
  assert.throws(() => latestPeriodic({}), /malformed/);
});

// ---------------------------------------------------------------------------- companyfacts

const WL = new Set([
  "us-gaap/RevenueFromContractWithCustomerExcludingAssessedTax",
  "us-gaap/EarningsPerShareDiluted",
  "us-gaap/CashAndCashEquivalentsAtCarryingValue",
  "dei/EntityCommonStockSharesOutstanding",
]);

const CF = {
  cik: 1,
  entityName: "Fixture Corp",
  facts: {
    dei: {
      EntityCommonStockSharesOutstanding: {
        units: { shares: [{ end: "2026-07-20", val: 1000, accn: "q2", fy: 2026, fp: "Q2", form: "10-Q", filed: "2026-07-25" }] },
      },
    },
    "us-gaap": {
      RevenueFromContractWithCustomerExcludingAssessedTax: {
        units: {
          USD: [
            // Q1 as first filed...
            { start: "2026-01-01", end: "2026-03-31", val: 100, accn: "q1", fy: 2026, fp: "Q1", form: "10-Q", filed: "2026-04-30" },
            // ...and as restated in the next filing: BOTH must survive, with their own filed dates.
            { start: "2026-01-01", end: "2026-03-31", val: 98, accn: "q2", fy: 2026, fp: "Q2", form: "10-Q", filed: "2026-07-30" },
            // Year to date, as a 10-Q files it.
            { start: "2026-01-01", end: "2026-06-30", val: 210, accn: "q2", fy: 2026, fp: "Q2", form: "10-Q", filed: "2026-07-30", frame: "CY2026H1" },
            // Same key twice in one accession with a different value: the first is kept, counted.
            { start: "2026-01-01", end: "2026-06-30", val: 999, accn: "q2", fy: 2026, fp: "Q2", form: "10-Q", filed: "2026-07-30" },
            // Unusable: no end date.
            { start: "2026-01-01", val: 5, accn: "q2", filed: "2026-07-30" },
          ],
        },
      },
      CashAndCashEquivalentsAtCarryingValue: {
        units: { USD: [{ end: "2026-06-30", val: 50, accn: "q2", fy: 2026, fp: "Q2", form: "10-Q", filed: "2026-07-30" }] },
      },
      // Not whitelisted: must not appear.
      NetIncomeLoss: {
        units: { USD: [{ start: "2026-01-01", end: "2026-03-31", val: 7, accn: "q1", filed: "2026-04-30" }] },
      },
      EarningsPerShareDiluted: {
        units: {
          "USD/shares": [
            { start: "2026-01-01", end: "2026-03-31", val: 0.1, accn: "q1", filed: "2026-04-30" },
            // Non-numeric value: dropped, not coerced to 0.
            { start: "2026-04-01", end: "2026-06-30", val: "n/a", accn: "q2", filed: "2026-07-30" },
          ],
        },
      },
    },
  },
};

Deno.test("extractFacts keeps only whitelisted concepts", () => {
  const { rows } = extractFacts(CF, "FIX", 1, WL);
  assert.ok(rows.every((r) => r.concept !== "NetIncomeLoss"));
  assert.deepEqual(
    [...new Set(rows.map((r) => `${r.taxonomy}/${r.concept}`))].sort(),
    [...WL].sort(),
  );
});

Deno.test("a restated value is KEPT beside the original, each with its own filing date", () => {
  const { rows } = extractFacts(CF, "FIX", 1, WL);
  const q1 = rows.filter((r) => r.concept.startsWith("Revenue") && r.period_end === "2026-03-31");
  assert.deepEqual(q1.map((r) => [r.val, r.filed]).sort(), [[100, "2026-04-30"], [98, "2026-07-30"]]);
});

Deno.test("instants carry period_start = period_end and is_instant; durations keep their start", () => {
  const { rows } = extractFacts(CF, "FIX", 1, WL);
  const cash = rows.find((r) => r.concept === "CashAndCashEquivalentsAtCarryingValue")!;
  assert.deepEqual([cash.period_start, cash.period_end, cash.is_instant], ["2026-06-30", "2026-06-30", true]);
  const ytd = rows.find((r) => r.concept.startsWith("Revenue") && r.period_end === "2026-06-30")!;
  assert.deepEqual([ytd.period_start, ytd.is_instant, ytd.frame], ["2026-01-01", false, "CY2026H1"]);
});

Deno.test("bad facts are dropped and counted, never zeroed; duplicate keys keep the first and count conflicts", () => {
  const r = extractFacts(CF, "FIX", 1, WL);
  assert.equal(r.dropped, 2, "the fact with no end, and the non-numeric EPS");
  assert.equal(r.conflicts, 1);
  const h1 = r.rows.filter((x) => x.concept.startsWith("Revenue") && x.period_end === "2026-06-30");
  assert.deepEqual(h1.map((x) => x.val), [210]);
  assert.ok(r.rows.every((x) => Number.isFinite(x.val)));
});

Deno.test("extractFacts reports accessions and the newest filed date, so a lagging companyfacts is detectable", () => {
  const r = extractFacts(CF, "FIX", 1, WL);
  assert.ok(r.accessions.has("q2") && r.accessions.has("q1"));
  assert.equal(r.newestFiled, "2026-07-30");
});

Deno.test("a document with no facts object is an error, not zero rows", () => {
  assert.throws(() => extractFacts({ cik: 1 }, "FIX", 1, WL), /no 'facts' object/);
});

// ---------------------------------------------------------------------------- SIC (Stage F2)

Deno.test("parseSic reads SEC's string code, and a missing or odd one is null, never 0", () => {
  assert.equal(parseSic({ sic: "6021" }), 6021);
  assert.equal(parseSic({ sic: 3674 }), 3674);
  assert.equal(parseSic({ sic: "" }), null);
  assert.equal(parseSic({ sic: "n/a" }), null);
  assert.equal(parseSic({}), null);
});

Deno.test("isBankSic is 6000-6199 exactly: banks yes, broker-dealers and insurers no", () => {
  assert.ok(isBankSic(6021), "national commercial bank (JPM)");
  assert.ok(isBankSic(6000) && isBankSic(6199), "both ends of the range");
  assert.ok(!isBankSic(6211), "security brokers");
  assert.ok(!isBankSic(6311), "life insurance");
  assert.ok(!isBankSic(5999) && !isBankSic(6200));
  assert.ok(!isBankSic(null));
});
