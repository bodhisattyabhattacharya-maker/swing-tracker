/**
 * ingest — sync the watchlist and pull daily bars into Postgres.
 *
 * In:      Authorization: Bearer <service_role key>   (anything else -> 401, see auth.ts)
 *          ?scope=tickers|daily|hourly|indices|all    default all
 *
 *          `indices` is the odd one: an index-ONLY pass, for the morning catch-up that exists
 *          because FRED publishes later than the evening run. It is not part of `all`, which
 *          already covers indices through `daily`. See provider.ts universeFor().
 *          `hourly` is NOT part of `all` either, since 2026-09-27 (decision 0058). It has its own
 *          schedule: one-minute bars are ~200x the payload of a daily top-up, and folding them
 *          into the nightly `all` run would put the equities back behind a wall clock they only
 *          just got out from under (the eleven names deferred on 2026-09-18).
 *          `fundamentals` (decision 0059) is SEC EDGAR, not bars: for each operating company it
 *          checks the newest periodic filing and, only when there is one it has not stored, fetches
 *          the companyfacts document into `sec_facts`. Its own schedule; not part of `all`.
 *          ?symbols=MU,NVDA                           restrict to these (default: every active row)
 *          ?full=1                                    force the full range, not incremental
 *          ?limit=10                                  max symbols fetched this run (default 10)
 *          ?shard=0/2                                 every 2nd symbol from the 0th - how the two
 *                                                     scheduled hourly jobs split the equities.
 *                                                     Chosen before planning, unlike offset; see
 *                                                     parseShard in provider.ts.
 *          ?by=<who>                                  ingest_runs.triggered_by (default "schedule")
 * Out:     JSON { ok, run_id, scope, tickers, daily, hourly, indices } and one row in
 *          ingest_runs. An `indices` run writes detail.indices, never detail.daily - grid_status
 *          judges freshness on the latter, and conflating them would make a dead equity pipeline
 *          look healthy every morning.
 *          A per-symbol failure is recorded in `errors` and does not abort the run; `ok` is
 *          false if any symbol failed, so a partial run is visible, not silent.
 * Sources: equities from ./polygon.ts, index series from ./fred.ts, routed by `supports()`
 *          (decision 0019). A symbol no provider claims is an error, never a silent gap.
 * Fails:   see each provider for the shapes that arrive as HTTP 200 but are not usable. A
 *          watchlist fetch or parse failure aborts the whole run, because a truncated watchlist
 *          would otherwise deactivate every ticker.
 *
 * WHY THIS RUNS IN BATCHES - the thing to understand before "fixing" the limit:
 *   Until 2026-09-13 the binding constraint was the rate limit: 5 requests/minute meant 12.5 s of
 *   wall clock per equity and four runs to cover the watchlist. On Stocks Starter calls are
 *   unlimited, so the binding constraint is now the edge function's **150 s wall clock** and the
 *   size of the payload, not politeness.
 *
 *   That changes the arithmetic, not the mechanism. A routine incremental run fetches 35 days per
 *   symbol - small payloads, ~39 symbols, comfortably one run. A `full` run fetches ~1250 bars per
 *   symbol and costs seconds each, so it still needs slicing. Hence two defaults below rather than
 *   one: the cost of the work decides the cap, so nobody has to remember to lower it.
 *
 *   Symbols with NO bars are always planned BEFORE symbols that only need a top-up, so a
 *   backfill cannot be starved by routine refreshes. Learned the hard way - INCIDENTS.md.
 *
 *   `offset` EXISTS FOR ONE-TIME DEEPENING, and it is deliberately manual. When the plan's history
 *   depth increases (free 2 years -> Starter 5), every symbol already has bars, so `full=1` marks
 *   all of them "full" on every run and a sliced run would redo the same first N forever - the
 *   plan order is stable and nothing distinguishes "already deepened" from "not yet". `offset`
 *   lets the operator walk the list: `full=1&limit=15`, then `&offset=15`, then `&offset=30`.
 *
 *   The rejected alternative was automatic depth detection - "re-fetch any symbol whose earliest
 *   bar is later than the window allows". It cannot work without recording state, because a
 *   symbol that simply LISTED later (SNDK, 2025-02-13) looks identical to one not yet deepened,
 *   and would be re-fetched on every run forever. Recording that state means a schema column for
 *   a one-time operation. `offset` is three lines and the operator can see what it did.
 *
 *   Not done yet, deliberately: Polygon's GROUPED daily endpoint returns every US ticker for one
 *   date in a single call, which would make the incremental path 1 request instead of 36. Worth
 *   doing once the per-symbol path is proven - see FEATURES.md.
 *
 * AUTH:    the function URL is derivable from a public repo, so the bearer must be the project's
 *          service_role key. auth.ts explains how that is checked and why both paths exist.
 *
 * PARTIAL BARS: during the session the last daily bar is live and partial. It is written as-is
 *          and overwritten by the next run. Only the post-close run should be trusted for
 *          settled values - that is what the four clocks in PROPOSAL.md are for.
 */

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { bearerToken, callerAllowed } from "../_shared/auth.ts";
import {
  autoFullCap,
  type BarProvider,
  inShard,
  isScope,
  parseShard,
  planLimit,
  type Range,
  RateLimitError,
  type Scope,
  SCOPES,
  universeFor,
  type Universe,
} from "./provider.ts";
import {
  mapOverview,
  mapSplits,
  polygon,
  POLYGON_MIN_INTERVAL_MS,
  referenceJson,
  splitsUrl,
  tickerOverviewUrl,
} from "./polygon.ts";
import { fred } from "./fred.ts";
import { fetchWatchlist } from "./watchlist.ts";
import { fetchNorms } from "./norms.ts";
import {
  companyFactsUrl,
  extractFacts,
  isBankSic,
  latestPeriodic,
  mapCompanyTickers,
  parseSic,
  SEC_FACTS_WAIT_DAYS,
  SEC_MIN_INTERVAL_MS,
  SEC_SOURCE,
  secJson,
  submissionsUrl,
  TICKERS_URL,
  validUserAgent,
} from "./sec.ts";

/**
 * Providers in routing order. The first one whose `supports()` returns true wins, so order
 * matters only if two ever overlap - today FRED claims "^"-prefixed series and Polygon claims
 * everything else, which is exhaustive and disjoint.
 */
const PROVIDERS: BarProvider[] = [fred, polygon];

const UPSERT_CHUNK = 1000; // PostgREST is happiest under a few thousand rows per call

/**
 * Per-run symbol caps, chosen from wall clock rather than from a rate limit - see the header.
 *
 * Incremental: 35 days is ~24 bars per symbol, so the whole watchlist fits one run with headroom
 * for tickers we add later. A routine refresh should never need a second run.
 *
 * Full: ~1250 bars per symbol at roughly 2-3 s each. 15 is about 40 s, which leaves real margin
 * under the 150 s wall clock - and a run killed by the wall clock loses every error record it had
 * collected, which is why the margin is generous rather than tight.
 */
// Per-run caps live in provider.ts alongside minIntervalMs - see planLimit there.

// Scope, its validator and the universe each one covers live in provider.ts, where they can be
// tested without this file's top-level Deno.serve starting a listener.

interface SymbolResult {
  counts: Record<string, number>;
  errors: Record<string, string>;
  /** Symbols left for the next run: over the per-run limit, or abandoned after a 429. */
  deferred: string[];
  /** Symbols whose provider does not serve this timeframe at all (FRED has no hourly). */
  skipped: string[];
  written: number;
  /** Set when a provider returned 429 and the rest of the run was abandoned deliberately. */
  rate_limited?: true;
}

function providerFor(symbol: string): BarProvider | null {
  return PROVIDERS.find((p) => p.supports(symbol)) ?? null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry a Supabase read once after a short pause.
 *
 * PostgREST on this project intermittently returns "Gateway Timeout", or an error with an EMPTY
 * message, on a perfectly ordinary count or select. It happened four times during the first
 * backfill and twice it killed an entire run. The project reports ACTIVE_HEALTHY, so this is
 * flakiness rather than a resource limit - and a read that fails once and succeeds 400 ms later
 * should not cost us eight symbols.
 *
 * Reads only. Nothing here retries a WRITE: an upsert that may have partially applied must not
 * be blindly repeated, and our upserts are idempotent enough that the next scheduled run fixes
 * them anyway.
 */
async function retryRead<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const first = e instanceof Error ? e.message : String(e);
    console.warn(`${what}: first attempt failed (${first || "empty error"}), retrying once`);
    await sleep(400);
    return await fn();
  }
}

// ---------------------------------------------------------------------------
// Auth - see auth.ts
// ---------------------------------------------------------------------------

function authorized(req: Request): boolean {
  return callerAllowed(bearerToken(req), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
}

// ---------------------------------------------------------------------------
// Tickers: yml -> table
// ---------------------------------------------------------------------------

/**
 * Sync the norms and flags blocks of config/norms.yml into their cache tables.
 *
 * Runs in the same scope as the ticker sync because it is the same kind of thing: a yml in the
 * public repo is the source of truth and these tables are its cache. The dashboard compares
 * against the TABLE, so a threshold edited in git reaches the grid on the next run of this.
 *
 * Removed norms are DELETED, unlike removed tickers which are deactivated. A stale ticker sits
 * inactive and harms nothing; a stale norm keeps silently colouring a cell against a rule that no
 * longer exists in git. `rs_vs_sox_6m` was removed exactly this way (decision 0019). The guard
 * that makes the delete safe is in norms.ts: an empty parse throws rather than wiping the table.
 */
async function syncNorms(sb: SupabaseClient, url?: string) {
  const { norms, flags } = await fetchNorms(url);
  const synced_at = new Date().toISOString();

  const { error: nErr } = await sb
    .from("norms")
    .upsert(norms.map((n) => ({ ...n, synced_at })), { onConflict: "param" });
  if (nErr) throw new Error(`norms upsert: ${nErr.message}`);

  const keepNorms = norms.map((n) => n.param);
  const { data: droppedNorms, error: dnErr } = await sb
    .from("norms")
    .delete()
    .not("param", "in", `(${keepNorms.map((p) => `"${p}"`).join(",")})`)
    .select("param");
  if (dnErr) throw new Error(`norms prune: ${dnErr.message}`);

  // Flags are stored as jsonb, so the value is wrapped rather than passed raw - a bare `true`
  // or `3` would be rejected by PostgREST as a malformed jsonb body.
  const { error: fErr } = await sb
    .from("flags")
    .upsert(flags.map((f) => ({ key: f.key, value: f.value, source: f.source, synced_at })), {
      onConflict: "key",
    });
  if (fErr) throw new Error(`flags upsert: ${fErr.message}`);

  const keepFlags = flags.map((f) => f.key);
  const { data: droppedFlags, error: dfErr } = keepFlags.length === 0
    ? { data: [], error: null }
    : await sb
      .from("flags")
      .delete()
      .not("key", "in", `(${keepFlags.map((k) => `"${k}"`).join(",")})`)
      .select("key");
  if (dfErr) throw new Error(`flags prune: ${dfErr.message}`);

  return {
    norms: norms.length,
    flags: flags.length,
    removed_norms: (droppedNorms ?? []).map((r: { param: string }) => r.param),
    removed_flags: (droppedFlags ?? []).map((r: { key: string }) => r.key),
  };
}

async function syncTickers(sb: SupabaseClient, url?: string) {
  const rows = await fetchWatchlist(url);
  // An empty parse is far more likely a broken file than an intentionally empty watchlist,
  // and acting on it would deactivate every ticker. Refuse.
  if (rows.length === 0) throw new Error("watchlist parsed to zero rows; refusing to sync");

  // Catch a watchlist symbol that no provider can serve NOW, at sync time, rather than as a
  // mystery gap in the grid later. Cheap, and it makes adding a ticker fail loudly if it needs
  // a provider we do not have (an index without a FRED series, say).
  const orphans = rows.filter((r) => providerFor(r.symbol) === null).map((r) => r.symbol);
  if (orphans.length) {
    throw new Error(`watchlist has symbols no provider serves: ${orphans.join(", ")}`);
  }

  const synced_at = new Date().toISOString();
  const { error: upErr } = await sb
    .from("tickers")
    .upsert(rows.map((r) => ({ ...r, synced_at })), { onConflict: "symbol" });
  if (upErr) throw new Error(`tickers upsert: ${upErr.message}`);

  // Anything not in the yml any more is deactivated, not deleted (see watchlist.ts header).
  const keep = rows.map((r) => r.symbol);
  const { data: off, error: offErr } = await sb
    .from("tickers")
    .update({ active: false, synced_at })
    .eq("active", true)
    .not("symbol", "in", `(${keep.map((s) => `"${s}"`).join(",")})`)
    .select("symbol");
  if (offErr) throw new Error(`tickers deactivate: ${offErr.message}`);

  return { synced: rows.length, deactivated: (off ?? []).map((r) => r.symbol) };
}

// ---------------------------------------------------------------------------
// Bars
// ---------------------------------------------------------------------------

async function activeSymbols(sb: SupabaseClient, only: string[] | null, universe: Universe) {
  return await retryRead("tickers read", async () => {
    let q = sb.from("tickers").select("symbol").eq("active", true);
    // A boolean here used to mean "include indices", which could not express "ONLY indices" - the
    // thing the morning catch-up run needs. Three named cases beat a flag answering two questions.
    if (universe === "equities") q = q.eq("is_index", false);
    if (universe === "indices") q = q.eq("is_index", true);
    // Filers only: an ETF is a trust with no income statement, and an index is not a company.
    if (universe === "companies") q = q.eq("is_index", false).eq("is_fund", false);
    if (only) q = q.in("symbol", only);
    const { data, error } = await q.order("symbol");
    if (error) throw new Error(`tickers read: ${error.message}`);
    return (data ?? []).map((r) => r.symbol as string);
  });
}

/** True if this symbol has at least one row in `table`. Drives the automatic full catch-up. */
async function hasBars(sb: SupabaseClient, table: "daily_bars" | "hourly_session_bars", symbol: string) {
  return await retryRead(`${table} count ${symbol}`, async () => {
    const { count, error } = await sb
      .from(table)
      .select("symbol", { count: "exact", head: true })
      .eq("symbol", symbol);
    if (error) throw new Error(`${table} count ${symbol}: ${error.message}`);
    return (count ?? 0) > 0;
  });
}

async function upsertChunked(sb: SupabaseClient, table: string, rows: unknown[], onConflict: string) {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const { error } = await sb.from(table).upsert(rows.slice(i, i + UPSERT_CHUNK), { onConflict });
    if (error) throw new Error(`${table} upsert: ${error.message}`);
  }
}

/**
 * Shared driver for both tables. Strictly sequential: each provider declares the gap it needs
 * between requests and we honour it per provider, so a slow equity API does not make the three
 * FRED series wait 12.5 s each.
 *
 * Never throws for a single symbol - it records the error and moves on. A 429 is the exception:
 * that aborts the run, because the next request would deepen the penalty rather than succeed.
 */
async function ingestBars(
  sb: SupabaseClient,
  kind: "daily" | "hourly",
  symbols: string[],
  forceFull: boolean,
  limit: number,
  offset: number,
  fullCap: number,
): Promise<SymbolResult> {
  // hourly_session_bars, not the older clock-aligned hourly_bars - see decision 0058. Nothing
  // writes to hourly_bars any more; it is kept, unread, until a migration of its own drops it.
  const table = kind === "daily" ? "daily_bars" : "hourly_session_bars";
  const key = kind === "daily" ? "symbol,d" : "symbol,ts";
  const result: SymbolResult = {
    counts: {},
    errors: {},
    deferred: [],
    skipped: [],
    written: 0,
  };

  /** Last request time per provider name, so pacing is per-provider rather than global. */
  const lastRequestAt = new Map<string, number>();
  let fetched = 0;
  let fullFetched = 0;

  // ---------------------------------------------------------------------------
  // PLAN BEFORE FETCHING, and put the symbols that have NO bars first.
  //
  // This ordering is the whole point. The first backfill walked symbols alphabetically and spent
  // its entire budget re-fetching five weeks of data for names that were already complete, while
  // 28 symbols with nothing at all sat in `deferred` run after run. It would have looped forever.
  // A symbol needing 494 bars and a symbol needing 24 must not compete on equal footing.
  //
  // Deciding the range up front also means a flaky count query is handled HERE, where a failure
  // costs one symbol, rather than inside the loop where it aborted the run twice tonight.
  // ---------------------------------------------------------------------------
  const plan: Array<{ symbol: string; provider: BarProvider; range: Range }> = [];
  for (const symbol of symbols) {
    const provider = providerFor(symbol);
    if (!provider) {
      result.errors[symbol] = "no provider serves this symbol";
      continue;
    }
    try {
      const range: Range = forceFull || !(await hasBars(sb, table, symbol)) ? "full" : "incremental";
      plan.push({ symbol, provider, range });
    } catch (e) {
      // One symbol's count failed even after a retry. Record it and carry on; it stays eligible
      // for a full catch-up next run because it still has no bars.
      result.errors[symbol] = e instanceof Error ? e.message : String(e);
    }
  }
  // Stable partition: everything needing a full backfill, then the cheap top-ups.
  plan.sort((a, b) => (a.range === b.range ? 0 : a.range === "full" ? -1 : 1));

  // Applied AFTER the sort, so `offset` walks the same ordered list every run - which is the only
  // reason it converges. Skipped symbols are reported as deferred because that is what they are:
  // not done this run. They are not errors and must not read as success either.
  if (offset > 0) {
    for (const p of plan.slice(0, offset)) result.deferred.push(p.symbol);
    plan.splice(0, offset);
    console.log(`${kind}: offset ${offset} - skipped ${result.deferred.length} planned symbols`);
  }
  console.log(
    `${kind}: ${plan.filter((p) => p.range === "full").length} to backfill, ` +
      `${plan.filter((p) => p.range === "incremental").length} to top up, limit ${limit}`,
  );

  for (const { symbol, provider, range } of plan) {
    // The per-run cap exists because of wall clock, not politeness - see the header.
    if (fetched >= limit) {
      result.deferred.push(symbol);
      continue;
    }
    // Automatic full fetches have their own, smaller cap - see autoFullCap in provider.ts. Checked
    // per symbol rather than by truncating the plan, so top-ups later in the list still run.
    if (range === "full" && fullFetched >= fullCap) {
      result.deferred.push(symbol);
      continue;
    }
    if (range === "full") fullFetched++;

    const since = Date.now() - (lastRequestAt.get(provider.name) ?? 0);
    if (since < provider.minIntervalMs) await sleep(provider.minIntervalMs - since);
    lastRequestAt.set(provider.name, Date.now());

    // Counted HERE, once, because this is the moment the rate budget is spent. Counting inside
    // the try (and again in the catch) double-charged a symbol that failed after its request,
    // which silently halved the run - a `bigint` upsert rejection is exactly that case.
    fetched++;

    // Breadcrumbs. The run row is only written at the end, so a run killed by the 150 s wall
    // clock leaves NO record of where it got to - the first live attempt was diagnosed from a
    // bare "504" and nothing else. These lines are the difference between a mystery and a fix.
    console.log(`${kind} ${symbol} via ${provider.name} (${range})`);

    try {
      const rows = kind === "daily"
        ? await provider.daily(symbol, range)
        : await provider.hourly(symbol, range);

      // null means "this provider does not serve this timeframe" - not a failure, and not zero
      // bars either. Distinguishing the two is what keeps `ok` meaningful. No request was made,
      // so hand the budget back.
      if (rows === null) {
        fetched--;
        if (range === "full") fullFetched--;
        result.skipped.push(symbol);
        continue;
      }

      await upsertChunked(sb, table, rows, key);
      result.counts[symbol] = rows.length;
      result.written += rows.length;
      console.log(`  ${symbol}: ${rows.length} rows`);
    } catch (e) {
      result.errors[symbol] = e instanceof Error ? e.message : String(e);
      console.error(`  ${symbol} FAILED: ${result.errors[symbol]}`);
      if (e instanceof RateLimitError) {
        result.rate_limited = true;
        // Abandon the rest; they are all still eligible for the full catch-up next run.
        for (const s of symbols.slice(symbols.indexOf(symbol) + 1)) {
          if (!(s in result.counts)) result.deferred.push(s);
        }
        break;
      }
    }
  }
  return result;
}


// ---------------------------------------------------------------------------
// Fundamentals: SEC EDGAR companyfacts -> sec_facts (decision 0059)
// ---------------------------------------------------------------------------

interface FundamentalsResult {
  /** Rows upserted per symbol. */
  counts: Record<string, number>;
  errors: Record<string, string>;
  /** Needed a fetch, did not get one this run: over the limit, skipped by offset, or after a 429. */
  deferred: string[];
  /** Checked and already current: the newest periodic filing is the one stored. */
  current: string[];
  /** The filing is in submissions but not yet in companyfacts; stored what exists, will retry. */
  lagging: string[];
  written: number;
  dropped: number;
  conflicts: number;
  rate_limited?: true;
  /** Stage F2: rows from a company's second CIK (XOM's pre-2026 history), per symbol. */
  extra_cik_rows: Record<string, number>;
  /** Stage F2: SEC industry codes that changed this run, and the bank flag they set. */
  sic_changed: Record<string, { sic: number | null; is_bank: boolean }>;
  /** Stage F2: Massive reference data - share counts and splits. Its failures are its own. */
  share_counts_written: number;
  splits_written: number;
  massive_errors: Record<string, string>;
  massive_rate_limited?: true;
}

/**
 * The daily EDGAR pass. Per company: one small `submissions` request; a companyfacts request only if
 * the newest periodic filing differs from the one recorded in `sec_filers` (or `full=1`).
 *
 * `last_accn` is advanced ONLY when that accession actually appears in the companyfacts document.
 * SEC's own processing can put a filing into submissions before its facts reach companyfacts; if we
 * advanced anyway, the company would read as current and that quarter would never arrive. Recorded
 * as `lagging` instead, and retried next run - for up to SEC_FACTS_WAIT_DAYS, after which a filing
 * that still has no facts (a 10-K/A adding only Part III) is accepted as carrying none.
 */
async function ingestFundamentals(
  sb: SupabaseClient,
  symbols: string[],
  forceFull: boolean,
  limit: number,
  offset: number,
): Promise<FundamentalsResult> {
  const result: FundamentalsResult = {
    counts: {},
    errors: {},
    deferred: [],
    current: [],
    lagging: [],
    written: 0,
    dropped: 0,
    conflicts: 0,
    extra_cik_rows: {},
    sic_changed: {},
    share_counts_written: 0,
    splits_written: 0,
    massive_errors: {},
  };

  // The contact line SEC requires. From a secret - this repo is public - and checked before any
  // request: a malformed one earns SEC's 403 "Request Rate Threshold Exceeded" page, and repeated
  // bad requests are how an IP gets blocked. Throwing here makes the whole run not-ok and says why.
  const ua = Deno.env.get("SEC_USER_AGENT");
  if (!validUserAgent(ua)) {
    throw new Error('SEC_USER_AGENT secret is missing or not "Name email" - no SEC request was sent');
  }

  let lastRequestAt = 0;
  const pace = async () => {
    const since = Date.now() - lastRequestAt;
    if (since < SEC_MIN_INTERVAL_MS) await sleep(SEC_MIN_INTERVAL_MS - since);
    lastRequestAt = Date.now();
  };

  // What to keep: the concept whitelist lives in the database so a label fix is a migration.
  const whitelist = await retryRead("sec_concept_map read", async () => {
    const { data, error } = await sb.from("sec_concept_map").select("taxonomy, concept");
    if (error) throw new Error(`sec_concept_map read: ${error.message}`);
    return new Set((data ?? []).map((r) => `${r.taxonomy}/${r.concept}`));
  });
  if (whitelist.size === 0) throw new Error("sec_concept_map is empty - nothing would be kept");

  // CIKs we already know, and what each company's newest stored filing is.
  const filers = await retryRead("sec_filers read", async () => {
    const { data, error } = await sb.from("sec_filers").select("symbol, cik, last_accn, sic").in("symbol", symbols);
    if (error) throw new Error(`sec_filers read: ${error.message}`);
    return new Map((data ?? []).map((r) => [
      r.symbol as string,
      { cik: r.cik as number, lastAccn: r.last_accn as string | null, sic: (r.sic ?? null) as number | null | undefined },
    ]));
  });

  // Second CIKs (sec_extra_ciks): fetched once, and again on full=1. Not re-checked daily - an old
  // CIK stops filing, which is exactly why it is extra.
  const extras = await retryRead("sec_extra_ciks read", async () => {
    const { data, error } = await sb.from("sec_extra_ciks").select("symbol, cik, fetched_at").in("symbol", symbols);
    if (error) throw new Error(`sec_extra_ciks read: ${error.message}`);
    return (data ?? []) as { symbol: string; cik: number; fetched_at: string | null }[];
  });

  // Massive reference data, paced on its own clock. Today's UTC date is the share count's as-of: the
  // SEC jobs run at 11:20 and 11:40 UTC, before the US open, so it is the same trading day in New York.
  const asOf = new Date().toISOString().slice(0, 10);
  let lastMassiveAt = 0;
  const paceMassive = async () => {
    const since = Date.now() - lastMassiveAt;
    if (since < POLYGON_MIN_INTERVAL_MS) await sleep(POLYGON_MIN_INTERVAL_MS - since);
    lastMassiveAt = Date.now();
  };
  // Its own try, its own error map: a plan that does not cover reference data must not cost the
  // SEC half of the run, and must still make the run not-ok so it is seen.
  const massiveFor = async (symbol: string) => {
    if (result.massive_rate_limited) return;
    try {
      await paceMassive();
      const ov = mapOverview(await referenceJson(tickerOverviewUrl(symbol), `${symbol}/overview`), symbol, asOf);
      if (ov) {
        await upsertChunked(sb, "share_counts", [ov], "symbol,as_of");
        result.share_counts_written++;
      }
      await paceMassive();
      const sp = mapSplits(await referenceJson(splitsUrl(symbol), `${symbol}/splits`), symbol);
      if (sp.rows.length) {
        await upsertChunked(sb, "splits", sp.rows, "symbol,execution_date");
        result.splits_written += sp.rows.length;
      }
      if (sp.dropped) console.log(`  ${symbol}: ${sp.dropped} split record(s) dropped as unusable`);
    } catch (e) {
      result.massive_errors[symbol] = e instanceof Error ? e.message : String(e);
      console.error(`  ${symbol} massive FAILED: ${result.massive_errors[symbol]}`);
      if (e instanceof RateLimitError) result.massive_rate_limited = true;
    }
  };

  // Unknown CIKs: one request for SEC's ticker file, only when needed.
  const unknown = symbols.filter((s) => !filers.has(s));
  if (unknown.length > 0) {
    await pace();
    const found = mapCompanyTickers(await secJson(TICKERS_URL, ua, "company_tickers"), unknown);
    const rows = Object.entries(found).map(([symbol, cik]) => ({ symbol, cik }));
    if (rows.length) await upsertChunked(sb, "sec_filers", rows, "symbol");
    // sic undefined, not null: a new filer's code is unknown, so the first submissions read writes it.
    for (const { symbol, cik } of rows) filers.set(symbol, { cik, lastAccn: null, sic: undefined });
    for (const s of unknown) if (!(s in found)) result.errors[s] = "no SEC CIK for this ticker in company_tickers.json";
  }

  let fetched = 0;
  let skippedByOffset = 0;

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    const f = filers.get(symbol);
    if (!f) continue; // already recorded as an error above

    // A forced run re-fetches everything anyway, so offset and limit are decided BEFORE spending a
    // submissions request on a company this run will not fetch - a hand-walked backfill of 43 would
    // otherwise pay 43 checks per slice for 5 fetches.
    if (forceFull) {
      if (skippedByOffset < offset) {
        skippedByOffset++;
        result.deferred.push(symbol);
        continue;
      }
      if (fetched >= limit) {
        result.deferred.push(symbol);
        continue;
      }
    }

    await massiveFor(symbol);

    try {
      await pace();
      const sub = await secJson(submissionsUrl(f.cik), ua, `${symbol}/submissions`);

      // The industry code rides on the document we already fetched. Written only when it changes, so
      // a daily run costs nothing here; is_bank follows it, set by SEC's classification, not ours.
      const sic = parseSic(sub);
      if (sic !== f.sic) {
        const { error: e1 } = await sb.from("sec_filers").update({ sic }).eq("symbol", symbol);
        if (e1) throw new Error(`sec_filers sic update: ${e1.message}`);
        const { error: e2 } = await sb.from("tickers").update({ is_bank: isBankSic(sic) }).eq("symbol", symbol);
        if (e2) throw new Error(`tickers is_bank update: ${e2.message}`);
        result.sic_changed[symbol] = { sic, is_bank: isBankSic(sic) };
        f.sic = sic;
      }

      // A second CIK, once. Counted against the same fetch limit: it is the same 2 s of CPU.
      for (const x of extras.filter((x) => x.symbol === symbol && (forceFull || !x.fetched_at))) {
        if (fetched >= limit) {
          result.deferred.push(`${symbol}@${x.cik}`);
          continue;
        }
        fetched++;
        await pace();
        const xdoc = await secJson(companyFactsUrl(x.cik), ua, `${symbol}/companyfacts@${x.cik}`);
        const xe = extractFacts(xdoc, symbol, x.cik, whitelist);
        await upsertChunked(sb, "sec_facts", xe.rows, "symbol,taxonomy,concept,unit,period_start,period_end,accn");
        const { error: e3 } = await sb.from("sec_extra_ciks")
          .update({ fetched_at: new Date().toISOString(), fact_rows: xe.rows.length })
          .eq("symbol", symbol).eq("cik", x.cik);
        if (e3) throw new Error(`sec_extra_ciks update: ${e3.message}`);
        result.extra_cik_rows[symbol] = (result.extra_cik_rows[symbol] ?? 0) + xe.rows.length;
        result.written += xe.rows.length;
        result.dropped += xe.dropped;
        result.conflicts += xe.conflicts;
        console.log(`  ${symbol}: ${xe.rows.length} facts from second CIK ${x.cik}`);
      }

      const latest = latestPeriodic(sub);
      if (!latest) {
        result.errors[symbol] = "no periodic filing (10-K/10-Q/20-F/40-F) in SEC's recent window";
        continue;
      }
      const needed = forceFull || f.lastAccn !== latest.accn;
      if (!needed) {
        result.current.push(symbol);
        continue;
      }
      // `offset` walks a backfill by hand, exactly as for bars: skip the first N that need work.
      if (!forceFull && skippedByOffset < offset) {
        skippedByOffset++;
        result.deferred.push(symbol);
        continue;
      }
      if (!forceFull && fetched >= limit) {
        result.deferred.push(symbol);
        continue;
      }
      fetched++;

      console.log(`fundamentals ${symbol} (CIK ${f.cik}) via ${SEC_SOURCE}: newest ${latest.form} ${latest.accn}`);
      await pace();
      const doc = await secJson(companyFactsUrl(f.cik), ua, `${symbol}/companyfacts`);
      const ex = extractFacts(doc, symbol, f.cik, whitelist);
      await upsertChunked(sb, "sec_facts", ex.rows, "symbol,taxonomy,concept,unit,period_start,period_end,accn");
      result.counts[symbol] = ex.rows.length;
      result.written += ex.rows.length;
      result.dropped += ex.dropped;
      result.conflicts += ex.conflicts;

      // See the function header: advance only if the filing has reached companyfacts - OR if it is
      // old enough that it never will. Some periodic filings carry no statement facts at all: a 6-K
      // press release, a 10-K/A that only adds Part III. Waiting on those forever would re-fetch a
      // multi-megabyte document every day for nothing. Ten days is far past SEC's normal lag
      // (a day or two) and short enough that a real lag is still retried.
      const arrived = ex.accessions.has(latest.accn);
      const ageDays = (Date.now() - Date.parse(`${latest.filed}T00:00:00Z`)) / 86_400_000;
      const settled = arrived || ageDays > SEC_FACTS_WAIT_DAYS;
      if (!settled) result.lagging.push(symbol);
      const { error } = await sb.from("sec_filers").update({
        last_accn: settled ? latest.accn : f.lastAccn,
        last_form: latest.form,
        last_filed: latest.filed,
        facts_fetched_at: new Date().toISOString(),
        fact_rows: ex.rows.length,
      }).eq("symbol", symbol);
      if (error) throw new Error(`sec_filers update: ${error.message}`);
      console.log(
        `  ${symbol}: ${ex.rows.length} facts` +
          (arrived ? "" : settled ? ` - ${latest.form} ${latest.accn} carries no statement facts` : " - newest filing not in companyfacts yet"),
      );
    } catch (e) {
      result.errors[symbol] = e instanceof Error ? e.message : String(e);
      console.error(`  ${symbol} FAILED: ${result.errors[symbol]}`);
      if (e instanceof RateLimitError) {
        result.rate_limited = true;
        for (const s of symbols.slice(i + 1)) result.deferred.push(s);
        break;
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);

  const url = new URL(req.url);
  const rawScope = url.searchParams.get("scope") ?? "all";
  if (!isScope(rawScope)) {
    return json({ error: `bad scope "${rawScope}" - expected one of ${SCOPES.join(", ")}` }, 400);
  }
  const scope: Scope = rawScope;
  const only = url.searchParams.get("symbols")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
  const forceFull = url.searchParams.get("full") === "1";
  // The default follows the cost of the work: a full backfill is ~50x the payload of a top-up, so
  // defaulting both to the same number would either throttle routine runs or get a backfill killed
  // halfway. An explicit ?limit= still overrides.
  // Hourly has its own defaults, because its per-symbol cost is a different order of magnitude.
  const limit = planLimit(
    forceFull,
    url.searchParams.get("limit"),
    scope === "hourly" ? "hourly" : scope === "fundamentals" ? "fundamentals" : "daily",
  );
  // Skip the first N of the planned work. Only useful for one-time deepening - see the header.
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
  let shard: { k: number; n: number } | null;
  try {
    shard = parseShard(url.searchParams.get("shard"));
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
  const triggeredBy = url.searchParams.get("by") ?? "schedule";

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Open the run row first so a crash mid-way still leaves a started-but-unfinished record.
  const { data: run, error: runErr } = await sb
    .from("ingest_runs")
    .insert({
      source: scope === "fundamentals" ? SEC_SOURCE : PROVIDERS.map((p) => p.name).join("+"),
      scope,
      triggered_by: triggeredBy,
    })
    .select("id")
    .single();
  if (runErr) return json({ error: `ingest_runs insert: ${runErr.message}` }, 500);

  const out: Record<string, unknown> = { ok: true, run_id: run.id, scope };
  let written = 0;
  let rateLimited = false;
  const problems: string[] = [];

  try {
    if (scope === "tickers" || scope === "all") {
      out.tickers = await syncTickers(sb, Deno.env.get("WATCHLIST_URL") ?? undefined);
      // Same scope, same reason: both are yml-in-git synced to a cache table. A norms failure
      // must not silently leave the grid comparing against yesterday's thresholds, so it throws
      // and the run is marked not-ok rather than partially succeeding.
      out.norms = await syncNorms(sb, Deno.env.get("NORMS_URL") ?? undefined);
    }
    if (scope === "daily" || scope === "all") {
      // Indices included: ^VIX, ^VIX3M and ^GSPC are the market block and relative-strength base.
      const syms = inShard(await activeSymbols(sb, only, universeFor(scope)!), shard);
      const r = await ingestBars(sb, "daily", syms, forceFull, limit, offset, autoFullCap("daily", forceFull));
      out.daily = r;
      written += r.written;
      rateLimited ||= r.rate_limited === true;
      problems.push(...Object.keys(r.errors).map((s) => `daily:${s}`));
    }
    if (scope === "indices") {
      // The index-only catch-up. FRED publishes later than the 22:30 run - on 2026-09-14 that run
      // fetched Friday's ^VIX while every equity came back same-evening - so a second pass the next
      // morning collects the previous close for three symbols instead of re-fetching 36.
      //
      // IT WRITES `detail.indices`, NOT `detail.daily`, AND THAT IS LOAD-BEARING. `grid_status`
      // counts a run as a data success only when `detail ? 'daily'`. If this run used that key it
      // would reset the staleness clock for the whole grid every morning, so a dead equity pipeline
      // would look healthy - the exact "successful operation that changed nothing" shape this
      // project keeps producing.
      const syms = inShard(await activeSymbols(sb, only, universeFor(scope)!), shard);
      const r = await ingestBars(sb, "daily", syms, forceFull, limit, offset, autoFullCap("daily", forceFull));
      out.indices = r;
      written += r.written;
      rateLimited ||= r.rate_limited === true;
      problems.push(...Object.keys(r.errors).map((s) => `indices:${s}`));
    }
    if (scope === "hourly" && !rateLimited) {
      // Hourly feeds RSI-hourly only, which is not computed for indices. Session-aligned since
      // 2026-09-27: polygon.ts fetches one-minute bars and session.ts buckets them into the seven
      // hours TradingView draws. ONLY on `scope=hourly` - see the header for why not `all`.
      //
      // Writes `detail.hourly`, never `detail.daily`. grid_status judges pipeline freshness on the
      // daily key, and an hourly success must not reset that clock - the same reasoning as the
      // `indices` run above.
      const syms = inShard(await activeSymbols(sb, only, universeFor(scope)!), shard);
      const r = await ingestBars(sb, "hourly", syms, forceFull, limit, offset, autoFullCap("hourly", forceFull));
      out.hourly = r;
      written += r.written;
      rateLimited ||= r.rate_limited === true;
      problems.push(...Object.keys(r.errors).map((s) => `hourly:${s}`));
    }
    if (scope === "fundamentals") {
      // Writes `detail.fundamentals`, never `detail.daily` - same reasoning as `indices` above: the
      // pipeline-staleness clock must only move when prices arrive.
      const syms = inShard(await activeSymbols(sb, only, universeFor(scope)!), shard);
      const r = await ingestFundamentals(sb, syms, forceFull, limit, offset);
      out.fundamentals = r;
      written += r.written;
      rateLimited ||= r.rate_limited === true;
      problems.push(...Object.keys(r.errors).map((s) => `fundamentals:${s}`));
      problems.push(...Object.keys(r.massive_errors).map((s) => `massive:${s}`));
    }
  } catch (e) {
    // Watchlist or table-level failure: the run is not ok, and the message is the detail.
    out.ok = false;
    out.fatal = e instanceof Error ? e.message : String(e);
  }
  if (problems.length) out.ok = false;
  // Surfaced at the top level so `select detail->>'rate_limited'` answers "why did this stop?"
  // without digging through per-symbol errors.
  if (rateLimited) out.rate_limited = true;

  await sb.from("ingest_runs").update({
    finished_at: new Date().toISOString(),
    ok: out.ok,
    rows_written: written,
    detail: out,
  }).eq("id", run.id);

  return json(out, out.ok ? 200 : 207);
});
