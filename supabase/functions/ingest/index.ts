/**
 * ingest — sync the watchlist and pull daily / hourly bars into Postgres.
 *
 * In:      Authorization: Bearer <service_role key>   (anything else -> 401, see AUTH below)
 *          ?scope=tickers|daily|hourly|all            default all
 *          ?symbols=MU,NVDA                           restrict to these (default: every active row)
 *          ?full=1                                    force the full range, not incremental
 *          ?limit=8                                   max full-range symbols per run (default 8)
 *          ?by=<who>                                  ingest_runs.triggered_by (default "schedule")
 * Out:     JSON { ok, run_id, scope, tickers, daily, hourly } and one row in ingest_runs.
 *          A per-symbol failure is recorded in `errors` and does not abort the run; `ok` is
 *          false if any symbol failed, so a partial run is visible, not silent.
 * Source:  Yahoo v8/finance/chart via ./yahoo.ts. Swap providers in PROVIDERS below.
 * Fails:   see yahoo.ts for the two "HTTP 200 but broken" shapes. A watchlist fetch or parse
 *          failure aborts the whole run (a wrong watchlist must not deactivate everything).
 * Rate:    2 symbols concurrently, 1 s between chunks, and a 429 aborts the whole run. The
 *          first live backfill did ~90 requests in 7 s and earned a 429 that was still in force
 *          6 minutes later (INCIDENTS.md 2026-09-13), so politeness here is not cosmetic.
 *
 * AUTH:    the function URL is derivable from the public repo, so it must not be callable by
 *          strangers - each call is ~80 requests to Yahoo on our egress. The bearer must be the
 *          project's service_role key: either its JWT payload says `role: service_role` (the
 *          gateway has already verified the signature - verify_jwt is on) or it byte-matches the
 *          runtime env var. See auth.ts for why both. pg_cron supplies the key from Vault
 *          (scheduling migration); a human supplies it from the SQL editor the same way.
 *
 * CATCH-UP: a symbol with no bars yet gets the full range automatically, so "add a line to the
 *          yml, commit" is enough - the next scheduled run backfills it. Full fetches are capped
 *          per run (`limit`) because a first run over 41 symbols would blow the wall-clock
 *          budget; the leftovers are listed in `deferred` and picked up next run. Calling with
 *          the same parameters again is safe: upserts are keyed on (symbol, d) / (symbol, ts).
 *
 * PARTIAL BARS: during the session Yahoo's last daily bar and last hourly bar are live and
 *          partial. They are written as-is and overwritten by the next run. Only the close-time
 *          daily run and the Saturday weekly roll should be trusted for settled values - that
 *          is what the four clocks in PROPOSAL.md are for.
 */

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { bearerToken, callerAllowed } from "./auth.ts";
import type { BarProvider, Range } from "./provider.ts";
import { RateLimitError, yahoo } from "./yahoo.ts";
import { fetchWatchlist } from "./watchlist.ts";

/** Registered providers. The active one is chosen by env `BAR_PROVIDER`, default yahoo. */
const PROVIDERS: Record<string, BarProvider> = { [yahoo.name]: yahoo };

// Yahoo rate-limits by IP and the penalty outlives the burst, so this is ~2 requests/second.
// Do not raise these to make a backfill finish sooner: a 429 costs the whole run and then some.
const CONCURRENCY = 2; // symbols in flight at once
const PAUSE_MS = 1000; // between chunks
const UPSERT_CHUNK = 1000; // PostgREST is happiest under a few thousand rows per call
const DEFAULT_FULL_LIMIT = 8;

type Scope = "tickers" | "daily" | "hourly" | "all";

interface SymbolResult {
  counts: Record<string, number>;
  errors: Record<string, string>;
  full: string[]; // symbols fetched with the full range this run
  deferred: string[]; // symbols that needed full but exceeded `limit`, or skipped after a 429
  written: number;
  /** Set when Yahoo returned 429 and the remaining symbols were abandoned deliberately. */
  rate_limited?: true;
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
  let q = sb.from("tickers").select("symbol").eq("active", true);
  if (!indices) q = q.eq("is_index", false);
  if (only) q = q.in("symbol", only);
  const { data, error } = await q.order("symbol");
  if (error) throw new Error(`tickers read: ${error.message}`);
  return (data ?? []).map((r) => r.symbol as string);
}

/** True if this symbol has at least one row in `table`. Drives the automatic full catch-up. */
async function hasBars(sb: SupabaseClient, table: "daily_bars" | "hourly_bars", symbol: string) {
  const { count, error } = await sb
    .from(table)
    .select("symbol", { count: "exact", head: true })
    .eq("symbol", symbol);
  if (error) throw new Error(`${table} count ${symbol}: ${error.message}`);
  return (count ?? 0) > 0;
}

async function upsertChunked(sb: SupabaseClient, table: string, rows: unknown[], onConflict: string) {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const { error } = await sb.from(table).upsert(rows.slice(i, i + UPSERT_CHUNK), { onConflict });
    if (error) throw new Error(`${table} upsert: ${error.message}`);
  }
}

/**
 * Shared driver for both tables. Decides the range per symbol, caps full fetches, then runs
 * the provider in polite chunks. Never throws for a single symbol - records it and moves on.
 */
async function ingestBars(
  sb: SupabaseClient,
  provider: BarProvider,
  kind: "daily" | "hourly",
  symbols: string[],
  forceFull: boolean,
  fullLimit: number,
): Promise<SymbolResult> {
  const table = kind === "daily" ? "daily_bars" : "hourly_bars";
  const key = kind === "daily" ? "symbol,d" : "symbol,ts";
  const result: SymbolResult = { counts: {}, errors: {}, full: [], deferred: [], written: 0 };

  // Plan first, fetch second, so the cap on full fetches is applied before any network call.
  const plan: Array<{ symbol: string; range: Range }> = [];
  for (const s of symbols) {
    const needsFull = forceFull || !(await hasBars(sb, table, s));
    if (!needsFull) {
      plan.push({ symbol: s, range: "incremental" });
    } else if (result.full.length < fullLimit) {
      result.full.push(s);
      plan.push({ symbol: s, range: "full" });
    } else {
      result.deferred.push(s);
    }
  }

  for (let i = 0; i < plan.length; i += CONCURRENCY) {
    const chunk = plan.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(async ({ symbol, range }) => {
      try {
        const rows = kind === "daily"
          ? await provider.daily(symbol, range)
          : await provider.hourly(symbol, range);
        await upsertChunked(sb, table, rows, key);
        result.counts[symbol] = rows.length;
        result.written += rows.length;
      } catch (e) {
        if (e instanceof RateLimitError) result.rate_limited = true;
        result.errors[symbol] = e instanceof Error ? e.message : String(e);
      }
    }));

    // A 429 means the IP is in a penalty window; the next request would extend it, not succeed.
    // Abandon the rest and let the next run pick them up - every symbol not yet in the table
    // still qualifies for the automatic full catch-up, so nothing is lost but time.
    if (result.rate_limited) {
      for (const { symbol } of plan.slice(i + CONCURRENCY)) {
        if (!(symbol in result.counts)) result.deferred.push(symbol);
      }
      break;
    }
    if (i + CONCURRENCY < plan.length) await new Promise((r) => setTimeout(r, PAUSE_MS));
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
  const fullLimit = Number(url.searchParams.get("limit") ?? DEFAULT_FULL_LIMIT);
  const triggeredBy = url.searchParams.get("by") ?? "schedule";

  const providerName = Deno.env.get("BAR_PROVIDER") ?? yahoo.name;
  const provider = PROVIDERS[providerName];
  if (!provider) return json({ error: `unknown BAR_PROVIDER "${providerName}"` }, 500);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Open the run row first so a crash mid-way still leaves a started-but-unfinished record.
  const { data: run, error: runErr } = await sb
    .from("ingest_runs")
    .insert({ source: provider.name, scope, triggered_by: triggeredBy })
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
      // Indices included: ^VIX, ^GSPC, ^SOX are daily-only context (params 22-25).
      const syms = await activeSymbols(sb, only, true);
      const r = await ingestBars(sb, provider, "daily", syms, forceFull, fullLimit);
      out.daily = r;
      written += r.written;
      rateLimited ||= r.rate_limited === true;
      problems.push(...Object.keys(r.errors).map((s) => `daily:${s}`));
    }
    if ((scope === "hourly" || scope === "all") && !rateLimited) {
      // Hourly feeds RSI-hourly only (param 10), which is not computed for indices.
      const syms = await activeSymbols(sb, only, false);
      const r = await ingestBars(sb, provider, "hourly", syms, forceFull, fullLimit);
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
