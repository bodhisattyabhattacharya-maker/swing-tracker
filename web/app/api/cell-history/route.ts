/**
 * /api/cell-history — one parameter's history, for one security.
 *
 * THE FIRST SERVER ENDPOINT IN THIS APP, AND THE ONLY ONE THAT READS THE DATABASE ON DEMAND.
 *
 * Everything else here is a server component: it reads at render time, the result is cached by ISR,
 * and no URL a visitor can type reaches PostgREST. This route breaks that, because the cell detail
 * sheet is a client component and cannot hold the service_role key — so the browser has to be able
 * to ask. That makes this file the one place in a PUBLIC repo where request input and a full-access
 * credential meet, and it is written accordingly.
 *
 * WHAT KEEPS IT FROM BEING A DATABASE PROXY:
 *
 *   1. `param` is checked against an ALLOWLIST DERIVED FROM `COLUMNS` (lib/cell-history.ts). Not a
 *      regex, not an escape - a membership test against the catalogue the grid renders from. A
 *      parameter the dashboard does not display cannot be requested.
 *   2. The allowlist also decides WHICH VIEW is read. The request does not name a table and cannot.
 *   3. `select` is a fixed string per view. Request input never reaches it, so this cannot be
 *      turned into "give me every column of every row".
 *   4. `symbol` must match a ticker shape AND exist in `tickers`, active and not an index. Shape
 *      first so nothing strange enters a URL; existence second so the endpoint cannot be used to
 *      enumerate what we do or do not track.
 *   5. `limit` is a constant. There is no page parameter to walk.
 *   6. Nothing here echoes the upstream error body. A PostgREST error can quote the failing SQL;
 *      on a public deployment that is free schema disclosure, so the detail goes to the log and the
 *      caller gets a sentence.
 *
 * If a future parameter needs a different view, it is added to `lib/cell-history.ts` and nowhere
 * else. This file should not grow a second branch.
 */

import { NextResponse } from "next/server";
import {
  MAX_POINTS,
  SELECT,
  VIEW,
  type HistoryPoint,
  validateRequest,
} from "../../../lib/cell-history";

/**
 * Cached for the same 15 minutes as the page, keyed on the query string.
 *
 * The data changes once a day; a viewer opening five cells in a row should hit the cache for four
 * of them. `force-static` is wrong here (the params are unbounded in principle) and `no-store`
 * would put a database read behind every click.
 */
export const revalidate = 900;

/** Never prerendered - there is nothing to prerender without a symbol and a param. */
export const dynamic = "force-dynamic";

function config(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ""), key };
}

async function read<T>(path: string, cfg: { url: string; key: string }): Promise<T> {
  const r = await fetch(`${cfg.url}/rest/v1/${path}`, {
    headers: {
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
      Accept: "application/json",
    },
    next: { revalidate },
  });
  if (!r.ok) {
    // Logged, not returned. See rule 6 in the header.
    console.error(`cell-history: ${path} -> HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
    throw new Error("upstream read failed");
  }
  return (await r.json()) as T;
}

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const v = validateRequest(q.get("symbol"), q.get("param"));
  if (!v.ok) {
    return NextResponse.json({ error: v.message }, { status: v.status });
  }

  const cfg = config();
  if (!cfg) {
    return NextResponse.json(
      { error: "this deployment has no database credentials configured" },
      { status: 503 },
    );
  }

  try {
    // Existence, before the history read. Cheap (primary key) and it means a request for a symbol
    // we do not track gets the same answer whether or not it is a real listing.
    const known = await read<Array<{ symbol: string }>>(
      `tickers?symbol=eq.${encodeURIComponent(v.symbol)}&active=eq.true&is_index=eq.false&select=symbol&limit=1`,
      cfg,
    );
    if (known.length === 0) {
      return NextResponse.json({ error: "not a tracked security" }, { status: 404 });
    }

    // MEASURED, NOT ASSUMED. `grid_cells` filtered by symbol AND param is 8.5 ms / 234 buffers on
    // production (2026-09-18) - the predicate pushes into daily_features_pk and weekly_features_pk,
    // so this is an index scan and not the full-view scan the plan expected. `rs_cells` the same at
    // 8.7 ms. That is why this endpoint needs no materialised history view; it is also why BOTH
    // filters are mandatory. Either one alone is a different plan entirely.
    const view = VIEW[v.source];
    const select = SELECT[v.source];
    const points = await read<HistoryPoint[]>(
      `${view}?symbol=eq.${encodeURIComponent(v.symbol)}&param=eq.${encodeURIComponent(v.param)}` +
        `&select=${select}&order=d.asc&limit=${MAX_POINTS}`,
      cfg,
    );

    return NextResponse.json({
      symbol: v.symbol,
      param: v.param,
      points,
      error: null,
    });
  } catch {
    return NextResponse.json(
      { error: "the history could not be read" },
      { status: 502 },
    );
  }
}
