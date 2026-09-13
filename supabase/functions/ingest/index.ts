/**
 * ingest — sync the watchlist and pull daily bars into Postgres.
 *
 * In:      Authorization: Bearer <service_role key>   (anything else -> 401, see auth.ts)
 *          ?scope=tickers|daily|hourly|all            default all
 *          ?symbols=MU,NVDA                           restrict to these (default: every active row)
 *          ?full=1                                    force the full range, not incremental
 *          ?limit=10                                  max symbols fetched this run (default 10)
 *          ?by=<who>                                  ingest_runs.triggered_by (default "schedule")
 * Out:     JSON { ok, run_id, scope, tickers, daily, hourly } and one row in ingest_runs.
 *          A per-symbol failure is recorded in `errors` and does not abort the run; `ok` is
 *          false if any symbol failed, so a partial run is visible, not silent.
 * Sources: equities from ./polygon.ts, index series from ./fred.ts, routed by `supports()`
 *          (decision 0019). A symbol no provider claims is an error, never a silent gap.
 * Fails:   see each provider for the shapes that arrive as HTTP 200 but are not usable. A
 *          watchlist fetch or parse failure aborts the whole run, because a truncated watchlist
 *          would otherwise deactivate every ticker.
 *
 * WHY THIS RUNS IN BATCHES - the thing to understand before "fixing" the limit:
 *   Polygon's free plan allows 5 requests/minute, so each equity costs 12.5 s of wall clock and
 *   an edge function does not live long enough to walk 36 of them. One run therefore fetches
 *   `limit` symbols and lists the rest in `deferred`; the next run picks them up, because a
 *   symbol with no bars still qualifies for the automatic full catch-up. Four runs cover the
 *   watchlist. Raising `limit` past ~11 does not go faster, it just gets the run killed halfway.
 *   Upgrading to Polygon Starter makes calls unlimited and this whole batching story goes away.
 *
 *   Symbols with NO bars are always planned BEFORE symbols that only need a top-up, so a
 *   backfill cannot be starved by routine refreshes. Learned the hard way - INCIDENTS.md.
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
import { bearerToken, callerAllowed } from "./auth.ts";
import { type BarProvider, type Range, RateLimitError } from "./provider.ts";
import { polygon } from "./polygon.ts";
import { fred } from "./fred.ts";
import { fetchWatchlist } from "./watchlist.ts";

/**
 * Providers in routing order. The first one whose `supports()` returns true wins, so order
 * matters only if two ever overlap - today FRED claims "^"-prefixed series and Polygon claims
 * everything else, which is exhaustive and disjoint.
 */
const PROVIDERS: BarProvider[] = [fred, polygon];

const UPSERT_CHUNK = 1000; // PostgREST is happiest under a few thousand rows per call
const DEFAULT_LIMIT = 10; // see "WHY THIS RUNS IN BATCHES"

type Scope = "tickers" | "daily" | "hourly" | "all";

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

async function activeSymbols(sb: SupabaseClient, only: string[] | null, indices: boolean) {
  return await retryRead("tickers read", async () => {
    let q = sb.from("tickers").select("symbol").eq("active", true);
    if (!indices) q = q.eq("is_index", false);
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
  const scope = (url.searchParams.get("scope") ?? "all") as Scope;
  if (!["tickers", "daily", "hourly", "all"].includes(scope)) {
    return json({ error: `bad scope "${scope}"` }, 400);
  }
  const only = url.searchParams.get("symbols")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
  const forceFull = url.searchParams.get("full") === "1";
  const limit = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
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
    }
    if (scope === "daily" || scope === "all") {
      // Indices included: ^VIX, ^VIX3M and ^GSPC are the market block and relative-strength base.
      const syms = await activeSymbols(sb, only, true);
      const r = await ingestBars(sb, "daily", syms, forceFull, limit);
      out.daily = r;
      written += r.written;
      rateLimited ||= r.rate_limited === true;
      problems.push(...Object.keys(r.errors).map((s) => `daily:${s}`));
    }
    if ((scope === "hourly" || scope === "all") && !rateLimited) {
      // Hourly feeds RSI-hourly only, which is not computed for indices. No provider serves
      // session-aligned hourly yet, so this currently reports every symbol as skipped - see
      // the HOURLY note in polygon.ts for why that is deliberate rather than broken.
      const syms = await activeSymbols(sb, only, false);
      const r = await ingestBars(sb, "hourly", syms, forceFull, limit);
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
