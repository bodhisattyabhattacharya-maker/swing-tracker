/**
 * sec.ts — SEC EDGAR XBRL facts, fetched and flattened for `sec_facts` (decision 0059).
 *
 * The PURE parts (URL building, ticker→CIK mapping, finding the latest periodic filing, flattening
 * companyfacts into rows) are exported and tested in sec_test.ts against small real-shaped
 * fixtures. The one impure function, `secJson`, is the fetch.
 *
 * ---------------------------------------------------------------------------
 * WHY EDGAR, AND WHAT IT BUYS
 *
 * Measured on production 2026-09-27 (Project doc: swing-tracker-edgar-probe-2026-09-27.md):
 * companyfacts keeps EVERY filed value with its own `filed` date and accession number. Apple's
 * diluted EPS has 25 periods whose value differs between filings (the 2020 split restatement), and
 * both values are there. That is the point-in-time property decision 0002 was chosen for, and it is
 * exactly what the vendor alternative (Massive Financials) documents that it does NOT keep.
 *
 * A concept a company did not file is ABSENT - never 0. So `sec_facts` never contains an invented
 * zero, and "null means not reported" holds by construction rather than by cleaning.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS STORED: every fact, for a WHITELIST of concepts
 *
 * The whitelist is `sec_concept_map` in the database, read at run time, so a label fix is a
 * migration and one forced re-fetch (43 requests), not a code change. Storing every concept for
 * every company would be ~20k rows a company; the whitelist keeps it to the ~30 concepts the
 * fundamentals layer can use, alternates included.
 *
 * Custom company-extension tags (Microsoft's own D&A line, for one) are NOT in companyfacts at all -
 * it carries only standard taxonomies. Those values are unavailable from this source, and the
 * coverage view says so per company rather than pretending.
 *
 * ---------------------------------------------------------------------------
 * FAIR ACCESS
 *
 * SEC requires a User-Agent naming a person or company and a contact email, and caps automated
 * access at 10 requests a second. The UA comes from the `SEC_USER_AGENT` secret, never from code:
 * this repo is public. Without a well-formed one SEC answers 403 with a page titled "Request Rate
 * Threshold Exceeded" - which is what the first probe got (2026-09-27), and why a missing or
 * malformed secret fails the run loudly here instead of being sent.
 */

import { fetchWithRetry } from "./http.ts";
import { RateLimitError } from "./provider.ts";

export const SEC_SOURCE = "sec-edgar";

/** 10 requests a second is SEC's ceiling; 150 ms keeps a margin under it. */
export const SEC_MIN_INTERVAL_MS = 150;

/**
 * How long a new periodic filing may sit in `submissions` without its facts appearing in companyfacts
 * before the ingest stops waiting for it. See index.ts ingestFundamentals.
 */
export const SEC_FACTS_WAIT_DAYS = 10;

export const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";

/**
 * Periodic reports that carry financial statements. 8-Ks, proxies, Form 4s and the rest are not
 * checked: a new 8-K does not change companyfacts' statement data, so waking on it would re-fetch
 * a 4 MB document for nothing.
 *
 * 6-K IS EXCLUDED ON PURPOSE. It is a foreign issuer's catch-all "current report": ASML files them
 * for buyback updates and press releases, often weekly, and almost none carry statement facts. As a
 * trigger it would re-fetch ASML's document most days for nothing. The cost is TSM's quarterly
 * XBRL 6-Ks, and TSM's SEC data already stops at 2024 (probe, 2026-09-27) - its quarters come from
 * the analyst vendor instead. A 20-F still triggers.
 */
export const PERIODIC_FORMS: ReadonlySet<string> = new Set([
  "10-K", "10-K/A", "10-Q", "10-Q/A", "20-F", "20-F/A", "40-F", "40-F/A",
]);

export function pad10(cik: number): string {
  return String(cik).padStart(10, "0");
}

export function submissionsUrl(cik: number): string {
  return `https://data.sec.gov/submissions/CIK${pad10(cik)}.json`;
}

export function companyFactsUrl(cik: number): string {
  return `https://data.sec.gov/api/xbrl/companyfacts/CIK${pad10(cik)}.json`;
}

/**
 * The User-Agent must name someone and carry an email. Checked before any request, because a bad
 * one does not fail politely - SEC answers with a rate-limit page and, repeated, may block the IP.
 */
export function validUserAgent(ua: string | undefined | null): ua is string {
  if (!ua) return false;
  const t = ua.trim();
  if (/YOUR_(NAME|EMAIL)/i.test(t)) return false;
  // "Name name@domain.tld" - at least one word before an address.
  return /^\S.*\s+[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
}

// ---------------------------------------------------------------------------
// company_tickers.json -> CIK
// ---------------------------------------------------------------------------

interface TickerEntry {
  cik_str?: number;
  ticker?: string;
  title?: string;
}

/**
 * Pure: SEC's ticker file -> { symbol: cik } for the symbols asked about. SEC writes class shares
 * with a hyphen (BRK-B) where some feeds use a dot, so both spellings are tried. A symbol that is
 * not found is simply absent from the result; the caller records it as an error for that symbol.
 */
export function mapCompanyTickers(json: unknown, symbols: string[]): Record<string, number> {
  if (json === null || typeof json !== "object") throw new Error("company_tickers: not an object");
  const byTicker = new Map<string, number>();
  for (const v of Object.values(json as Record<string, TickerEntry>)) {
    if (v && typeof v.ticker === "string" && typeof v.cik_str === "number") {
      // First wins: the file lists a company's primary ticker first.
      if (!byTicker.has(v.ticker)) byTicker.set(v.ticker, v.cik_str);
    }
  }
  const out: Record<string, number> = {};
  for (const s of symbols) {
    const cik = byTicker.get(s) ?? byTicker.get(s.replace(".", "-"));
    if (cik !== undefined) out[s] = cik;
  }
  return out;
}

// ---------------------------------------------------------------------------
// submissions -> the newest periodic filing
// ---------------------------------------------------------------------------

export interface PeriodicFiling {
  accn: string;
  form: string;
  filed: string;
}

interface Submissions {
  filings?: {
    recent?: {
      accessionNumber?: string[];
      form?: string[];
      filingDate?: string[];
    };
  };
}

/**
 * Pure: the newest periodic filing in `filings.recent`, which SEC orders newest first. Null when
 * there is none in the recent window (a company that has not filed a statement in ~1,000 filings).
 */
export function latestPeriodic(json: unknown): PeriodicFiling | null {
  const r = (json as Submissions)?.filings?.recent;
  if (!r || !Array.isArray(r.accessionNumber) || !Array.isArray(r.form) || !Array.isArray(r.filingDate)) {
    throw new Error("submissions: filings.recent is missing or malformed");
  }
  let best: PeriodicFiling | null = null;
  for (let i = 0; i < r.accessionNumber.length; i++) {
    const form = r.form[i];
    if (!PERIODIC_FORMS.has(form)) continue;
    const cand = { accn: r.accessionNumber[i], form, filed: r.filingDate[i] };
    // Ordered newest first in practice, but "in practice" is how a ranking assumption fails silently.
    if (!best || cand.filed > best.filed) best = cand;
  }
  return best;
}

// ---------------------------------------------------------------------------
// companyfacts -> sec_facts rows
// ---------------------------------------------------------------------------

/** Matches `sec_facts` column for column. */
export interface SecFactRow {
  symbol: string;
  cik: number;
  taxonomy: string;
  concept: string;
  unit: string;
  /** Equal to period_end for an instant (balance-sheet) fact, so the key needs no nulls. */
  period_start: string;
  period_end: string;
  is_instant: boolean;
  val: number;
  accn: string;
  form: string | null;
  fy: number | null;
  fp: string | null;
  filed: string;
  frame: string | null;
}

interface RawFact {
  start?: string;
  end?: string;
  val?: unknown;
  accn?: string;
  fy?: unknown;
  fp?: unknown;
  form?: unknown;
  filed?: string;
  frame?: unknown;
}

export interface ExtractResult {
  rows: SecFactRow[];
  /** Facts dropped for a missing end, filed date, accession or a non-finite value. */
  dropped: number;
  /** Same key filed twice in one accession with DIFFERENT values: first kept, count reported. */
  conflicts: number;
  /** The newest `filed` date among the rows kept, or null. */
  newestFiled: string | null;
  /** Every accession number seen, so the caller can tell whether a filing has reached companyfacts. */
  accessions: Set<string>;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Pure: flatten companyfacts into rows for the whitelisted concepts only. `whitelist` holds
 * "taxonomy/concept" strings.
 *
 * Never throws on a bad individual fact - it is dropped and counted. It throws only when the
 * document itself is not a companyfacts document, because writing nothing and reporting success
 * is the failure this project keeps meeting.
 */
export function extractFacts(json: unknown, symbol: string, cik: number, whitelist: ReadonlySet<string>): ExtractResult {
  const facts = (json as { facts?: Record<string, Record<string, { units?: Record<string, RawFact[]> }>> })?.facts;
  if (!facts || typeof facts !== "object") throw new Error(`${symbol}: companyfacts has no 'facts' object`);

  const rows: SecFactRow[] = [];
  const seen = new Map<string, number>();
  const accessions = new Set<string>();
  let dropped = 0;
  let conflicts = 0;
  let newestFiled: string | null = null;

  for (const [taxonomy, concepts] of Object.entries(facts)) {
    for (const [concept, body] of Object.entries(concepts ?? {})) {
      if (!whitelist.has(`${taxonomy}/${concept}`)) continue;
      for (const [unit, list] of Object.entries(body?.units ?? {})) {
        if (!Array.isArray(list)) continue;
        for (const f of list) {
          const val = typeof f.val === "number" ? f.val : Number.NaN;
          if (
            !f.end || !ISO_DATE.test(f.end) || !f.filed || !ISO_DATE.test(f.filed) || !f.accn ||
            !Number.isFinite(val) || (f.start !== undefined && !ISO_DATE.test(f.start))
          ) {
            dropped++;
            continue;
          }
          const start = f.start ?? f.end;
          const key = `${taxonomy}|${concept}|${unit}|${start}|${f.end}|${f.accn}`;
          const prior = seen.get(key);
          if (prior !== undefined) {
            if (prior !== val) conflicts++;
            continue;
          }
          seen.set(key, val);
          accessions.add(f.accn);
          if (!newestFiled || f.filed > newestFiled) newestFiled = f.filed;
          rows.push({
            symbol,
            cik,
            taxonomy,
            concept,
            unit,
            period_start: start,
            period_end: f.end,
            is_instant: f.start === undefined,
            val,
            accn: f.accn,
            form: typeof f.form === "string" ? f.form : null,
            fy: typeof f.fy === "number" ? f.fy : null,
            fp: typeof f.fp === "string" ? f.fp : null,
            filed: f.filed,
            frame: typeof f.frame === "string" ? f.frame : null,
          });
        }
      }
    }
  }
  return { rows, dropped, conflicts, newestFiled, accessions };
}

// ---------------------------------------------------------------------------
// The fetch
// ---------------------------------------------------------------------------

/**
 * GET a SEC JSON document. 403 is named for what it almost always is - a User-Agent SEC does not
 * accept - and 429 is a RateLimitError so the caller stops the run instead of skipping ahead.
 */
export async function secJson(url: string, ua: string, label: string): Promise<unknown> {
  const r = await fetchWithRetry(
    url,
    { headers: { "User-Agent": ua, "Accept": "application/json" } },
    { label: `${SEC_SOURCE}/${label}`, timeoutMs: 30_000 },
  );
  if (r.status === 429) throw new RateLimitError(SEC_SOURCE, label);
  if (r.status === 403) {
    throw new Error(`${label}: HTTP 403 from SEC - usually a User-Agent it will not accept ("Name email" required)`);
  }
  if (r.status === 404) throw new Error(`${label}: HTTP 404 - no such CIK document at SEC`);
  if (!r.ok) throw new Error(`${label}: HTTP ${r.status} from SEC`);
  return await r.json();
}

// ---------------------------------------------------------------------------
// submissions -> the SEC industry code (Stage F2, decision 0060)
// ---------------------------------------------------------------------------

/**
 * Pure: the Standard Industrial Classification code SEC files the company under, from the same
 * submissions document the ingest already reads. SEC sends it as a string ("6021"); an empty or
 * non-numeric one is null, never 0 - 0 is not an industry.
 */
export function parseSic(json: unknown): number | null {
  const raw = (json as { sic?: unknown })?.sic;
  const s = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  return /^\d{3,4}$/.test(s) ? Number(s) : null;
}

/**
 * Banks, for the fundamentals that do not apply to one (DEFINITIONS §7, decision 2 of 2026-09-28):
 * SIC 6000-6199 is depository institutions and credit agencies - national and state commercial
 * banks (6021, 6022), savings institutions, credit unions, federal credit agencies. Broker-dealers
 * (6211) and insurers (63xx) are outside it on purpose: they have debt that means what it says.
 */
export function isBankSic(sic: number | null): boolean {
  return sic !== null && sic >= 6000 && sic <= 6199;
}
