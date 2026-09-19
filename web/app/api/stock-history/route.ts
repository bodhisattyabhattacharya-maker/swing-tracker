/**
 * /api/stock-history — one security's price series and its moving averages, at one timeframe.
 *
 * THE SECOND SERVER ENDPOINT IN THIS APP, and it is written to the rules the first one established.
 * `/api/cell-history`'s header sets out why a route that holds the service_role key on a PUBLIC
 * repo is a different kind of file; everything there applies here. What is different is only what
 * is bounded: a cell history bounds the PARAM against the column catalogue, and this bounds the
 * TIMEFRAME against a two-value union that also decides which relations are read.
 *
 * WHAT KEEPS IT FROM BEING A DATABASE PROXY:
 *
 *   1. `tf` is a membership test against `TIMEFRAMES` (lib/stock-history.ts), and it is the tf —
 *      not the request — that names the relations. The caller cannot name a table.
 *   2. `select` is built from `OVERLAYS` at module load. Request input never reaches it, so this
 *      cannot be turned into "every column of every row".
 *   3. `symbol` must match a ticker shape AND exist in `tickers`, active and not an index. Shape
 *      first so nothing strange enters a URL; existence second so the endpoint cannot be used to
 *      enumerate what we track.
 *   4. `limit` is a constant per timeframe. There is no page parameter to walk.
 *   5. Nothing echoes the upstream error body — a PostgREST error can quote the failing SQL, which
 *      on a public deployment is free schema disclosure. The detail goes to the log.
 *
 * ---------------------------------------------------------------------------
 * WHY TWO READS AND NOT ONE JOIN
 *
 * Measured on production, 2026-09-19, NVDA over 260 bars:
 *
 *   daily_bars LEFT JOIN daily_features in SQL   9.745 ms   797 buffers
 *   daily_bars alone                             1.186 ms    17 buffers
 *   daily_features alone                         0.218 ms    16 buffers
 *
 * The join is a nested loop of 260 index lookups and 780 of those buffers are that loop. Two flat
 * index scans stitched by date in `stitch()` cost about a seventh of the time on a twenty-fourth of
 * the buffers, and need no view. Decision 0048 deleted a planned view by measuring it; this is the
 * same move applied to a join, and it is recorded here because the intuition — "let the database do
 * the join" — is the one that loses.
 */

import { NextResponse } from "next/server";
import {
  BARS,
  barSelect,
  FEATURES,
  featureSelect,
  MAX_BARS,
  type Series,
  stitch,
  validateRequest,
} from "../../../lib/stock-history";

/** Cached for the same 15 minutes as the page. Bars change once a day. */
export const revalidate = 900;

/** Never prerendered — there is nothing to prerender without a symbol. */
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
    // Logged, not returned. See rule 5 in the header.
    console.error(`stock-history: ${path.split("?")[0]} -> HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
    throw new Error("upstream read failed");
  }
  return (await r.json()) as T;
}

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const v = validateRequest(q.get("symbol"), q.get("tf"));
  if (!v.ok) return NextResponse.json({ error: v.message }, { status: v.status });

  const cfg = config();
  if (!cfg) {
    return NextResponse.json(
      { error: "this deployment has no database credentials configured" },
      { status: 503 },
    );
  }

  const sym = encodeURIComponent(v.symbol);
  const bars = BARS[v.tf];
  const feats = FEATURES[v.tf];
  const limit = MAX_BARS[v.tf];

  try {
    const known = await read<Array<{ symbol: string }>>(
      `tickers?symbol=eq.${sym}&active=eq.true&is_index=eq.false&select=symbol&limit=1`,
      cfg,
    );
    if (known.length === 0) {
      return NextResponse.json({ error: "not a tracked security" }, { status: 404 });
    }

    // Both reads go out together; they are independent index scans against the same host.
    // NEWEST FIRST, THEN SORTED ASCENDING IN `stitch`. `order=<time>.desc&limit=N` stops the index
    // scan after N rows; `order=<time>.asc&limit=N` would return the OLDEST N of a five-year series,
    // which is the same trap the market-history read documents.
    const [barRows, featureRows] = await Promise.all([
      read<Array<Record<string, unknown>>>(
        `${bars.view}?symbol=eq.${sym}${bars.filter}` +
          `&select=${barSelect(v.tf)}&order=${bars.time}.desc&limit=${limit}`,
        cfg,
      ),
      read<Array<Record<string, unknown>>>(
        `${feats.view}?symbol=eq.${sym}${feats.filter}` +
          `&select=${featureSelect(v.tf)}&order=${feats.time}.desc&limit=${limit}`,
        cfg,
      ),
    ]);

    const { bars: series, overlays } = stitch(v.tf, barRows, featureRows);

    const body: Series = {
      symbol: v.symbol,
      tf: v.tf,
      bars: series,
      overlays,
      error: null,
      lastBar: series.length > 0 ? series[series.length - 1].time : null,
    };
    return NextResponse.json(body);
  } catch {
    return NextResponse.json({ error: "the price series could not be read" }, { status: 502 });
  }
}
