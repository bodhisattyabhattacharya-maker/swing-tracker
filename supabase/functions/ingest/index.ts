/**
 * ingest — sync the watchlist and pull daily bars into Postgres.
 *
 * In:      Authorization: Bearer <service_role key>   (anything else -> 401, see auth.ts)
 *          ?scope=tickers|daily|hourly|indices|all    default all
 *
 *          `indices` is the odd one: an index-ONLY pass, for the morning catch-up that exists
 *          because FRED publishes later than the evening run. It is not part of `all`, which
 *          already covers indices through `daily`. See provider.ts universeFor().
 *          ?symbols=MU,NVDA                           restrict to these (default: every active row)
 *          ?full=1                                    force the full range, not incremental
 *          ?limit=10                                  max symbols fetched this run (default 10)
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
  type BarProvider,
  isScope,
  planLimit,
  type Range,
  RateLimitError,
  type Scope,
  SCOPES,
  universeFor,
  type Universe,
} from "./provider.ts";
import { polygon } from "./polygon.ts";
import { fred } from "./fred.ts";
import { fetchWatchlist } from "./watchlist.ts";
import { fetchNorms } from "./norms.ts";

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
    if (only) q = q.in("symbol", only);
    const { data, error } = await q.order("symbol");
    if (error) throw new Error(`tickers read: ${error.message}`);
    return (data ?? []).map((r) => r.symbol as string);
  });
}

/** True if this symbol has at least one row in `table`. Drives the automatic full catch-up. */
async function hasBars(sb: SupabaseClient, table: "daily_bars" | "hourly_bars", symbol: string) {
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
): Promise<SymbolResult> {
  const table = kind === "daily" ? "daily_bars" : "hourly_bars";
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
  const limit = planLimit(forceFull, url.searchParams.get("limit"));
  // Skip the first N of the planned work. Only useful for one-time deepening - see the header.
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
  const triggeredBy = url.searchParams.get("by") ?? "schedule";

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Open the run row first so a crash mid-way still leaves a started-but-unfinished record.
  const { data: run, error: runErr } = await sb
    .from("ingest_runs")
    .insert({ source: PROVIDERS.map((p) => p.name).join("+"), scope, triggered_by: triggeredBy })
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
      const syms = await activeSymbols(sb, only, universeFor(scope)!);
      const r = await ingestBars(sb, "daily", syms, forceFull, limit, offset);
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
      const syms = await activeSymbols(sb, only, universeFor(scope)!);
      const r = await ingestBars(sb, "daily", syms, forceFull, limit, offset);
      out.indices = r;
      written += r.written;
      rateLimited ||= r.rate_limited === true;
      problems.push(...Object.keys(r.errors).map((s) => `indices:${s}`));
    }
    if ((scope === "hourly" || scope === "all") && !rateLimited) {
      // Hourly feeds RSI-hourly only, which is not computed for indices. No provider serves
      // session-aligned hourly yet, so this currently reports every symbol as skipped - see
      // the HOURLY note in polygon.ts for why that is deliberate rather than broken.
      const syms = await activeSymbols(sb, only, universeFor(scope)!);
      const r = await ingestBars(sb, "hourly", syms, forceFull, limit, offset);
      out.hourly = r;
      written += r.written;
      rateLimited ||= r.rate_limited === true;
      problems.push(...Object.keys(r.errors).map((s) => `hourly:${s}`));
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
