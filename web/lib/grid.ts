/**
 * grid.ts — the only place this app talks to the database.
 *
 * SERVER ONLY. Nothing here may be imported into a client component. It reads with the
 * service_role key, which is a full-access credential: if it reached the browser bundle the repo's
 * entire security model would be gone, and the repo is public so it would be gone permanently.
 * Two things keep that from happening and both matter -
 *   1. The env var is `SUPABASE_SERVICE_ROLE_KEY`, with **no** `NEXT_PUBLIC_` prefix. Next inlines
 *      `NEXT_PUBLIC_*` into the client bundle at build time. That prefix is the whole hazard.
 *   2. This module is only ever imported by a server component. There is no "use client" anywhere
 *      in this app and there should not be one in a file that leads here.
 *
 * WHY POSTGREST OVER HTTP AND NOT A POSTGRES CONNECTION: ten people on multiple devices hitting
 * serverless functions that each open a database connection is how a connection pool is exhausted.
 * HTTP has no such limit, and the response is cacheable, so all ten viewers are served from one
 * upstream read (v1 scope decision, 2026-09-13).
 *
 * WHY THE BROWSER NEVER READS DIRECTLY: the page is public and has no login, but the database is
 * not. Serving it from the server means RLS stays deny-by-default with no read policy at all -
 * nothing to get subtly wrong on a schema that anyone can read in a public repo.
 *
 * NOTHING HERE THROWS. A missing env var or a failed fetch returns an `error` string that the page
 * renders as a panel. Two reasons: CI builds this with no environment at all and must not fail,
 * and a thrown error in a server component is a 500 for every viewer - a worse outcome than a page
 * that says what is wrong.
 */

/**
 * How long a response is reused. The data changes once a day; this bounds how stale a view is.
 *
 * `as const` is load-bearing: it narrows the type to the literal 900 so the page can assert, at
 * compile time, that its own `revalidate` export matches. Next requires that export to be a literal
 * it can statically analyse - an imported constant fails the build with "Invalid segment
 * configuration export" - so the number genuinely has to appear twice, and the assertion is what
 * stops the two copies drifting silently.
 */
export const REVALIDATE_SECONDS = 900 as const;

export type Verdict = "below" | "normal" | "above" | null;

export interface Cell {
  symbol: string;
  param: string;
  value: number | null;
  verdict: Verdict;
  has_norm: boolean;
  suppressed_warmup: boolean;
}

export interface Ticker {
  symbol: string;
  name: string;
  theme: string;
  bellwether: boolean;
  /** An ETF. Price parameters apply; fundamentals are NOT APPLICABLE, not missing (decision 0041). */
  is_fund: boolean;
  /** False for a theme that is not a peer group, which makes a sector rank meaningless rather than absent. */
  rankable: boolean;
}

/**
 * A signal cell: categorical, from `signal_cells`. Same row shape as `Cell` but the payload is a
 * label plus an optional number, and the colour comes from `tone` rather than a norm verdict.
 */
export interface SignalCell {
  symbol?: string;
  param?: string;
  label?: string | null;
  value?: number | null;
  tone?: string | null;
  seed_ok?: boolean | null;
}

/**
 * EVERY FIELD IS OPTIONAL, AND THAT IS THE POINT — not laziness about typing.
 *
 * This shape is not validated at runtime; it is an assertion about a JSON document fetched over
 * HTTP from a view that deploys on a different schedule from this build. Declaring
 * `hours_since_success: number | null` told TypeScript the field is ALWAYS THERE, which is exactly
 * the guarantee two independent pipelines cannot give. On 2026-09-13 Vercel prerendered this page
 * against a `grid_status` that did not yet have the field; it arrived as `undefined`, the render
 * read that as "never", and the dashboard displayed "Last ingest: never · ok" while the pipeline
 * was entirely healthy (INCIDENTS.md).
 *
 * With `?` the compiler forces every reader to decide what an absent field means, which is the only
 * place that decision can be made honestly:
 *
 *   undefined  the field was not in the response. We know nothing. Never a verdict.
 *   null       the view returned SQL NULL. A real fact - e.g. the ingest has never succeeded.
 *   a value    the answer.
 */
export interface Status {
  data_through?: string | null;
  symbols?: number | null;
  /** Published as a fact, NOT as the verdict — a market holiday is not a failed pipeline. */
  days_behind?: number | null;
  /**
   * How many tracked symbols actually have a bar on `data_through`, and how many do not.
   *
   * `symbols` counts every active non-index ticker with ANY history; `symbols_priced` counts only
   * those present on the newest date. On 2026-09-18 the first was 53 and the second 42, and the
   * page showed only the first — "53 names · Data through 2026-09-17 · ok" — while eleven rows were
   * a day behind because the ingest had deferred them over its per-run cap. Both numbers were true.
   * Together, without the second, they were a lie of omission on the one page whose stated job is
   * not to hide staleness.
   *
   * Optional for the reason every field here is: this shape is an assertion about a JSON document
   * from a view that deploys on its own schedule. `undefined` means the deployment predates
   * migration 20260918060000 and we know nothing — never render that as "all present".
   */
  symbols_priced?: number | null;
  symbols_behind?: number | null;
  /** Hours since the daily ingest last completed successfully. null means it never has. */
  hours_since_success?: number | null;
  last_success_at?: string | null;
  stale_after_hours?: number | null;
  /** The verdict, and it measures the PIPELINE. See the grid_status view header. */
  is_stale?: boolean | null;
  /** The LAST run, which is a different question from the last GOOD run — showing both is what
   *  distinguishes "nothing has run" from "it ran and failed". */
  last_run_at?: string | null;
  last_run_ok?: boolean | null;
  last_run_by?: string | null;
}

export interface Norm {
  param: string;
  low: number | null;
  high: number | null;
}

/**
 * A market-block cell. Same shape as `Cell` plus `as_of`, because these four numbers are NOT all
 * from the same session and a block that implied they were would be claiming something it cannot
 * know: VIX and SPX come from FRED, which publishes hours after the equities, and on the day one
 * publishes and the other does not they are a day apart from each other (decision 0034).
 *
 * Optional for the same reason every field of Status is — see that comment. This is a JSON document
 * from a view that deploys on a different schedule from this build.
 */
export interface MarketCell {
  param?: string;
  value?: number | null;
  as_of?: string | null;
  verdict?: Verdict;
  has_norm?: boolean;
}

/** One row of `market_history`. Mirrors lib/market-history.ts's MarketRow, optional for the same
 *  reason every field of Status is: it is a JSON document from a view on its own deploy schedule. */
export interface MarketHistoryRow {
  d?: string;
  vix?: number | null;
  vix_band?: string | null;
  vix3m?: number | null;
  term_structure?: number | null;
  spx_close?: number | null;
  breadth_pct?: number | null;
  breadth_tracked?: number | null;
  vix_ma20?: number | null;
  vix_ma20_bars?: number | null;
}

export interface GridData {
  status: Status | null;
  tickers: Ticker[];
  cells: Cell[];
  norms: Norm[];
  /** The market block. Empty with `marketError` set if it could not be read. */
  market: MarketCell[];
  /** Relative-strength cells at THEIR newest date, which trails the grid's most evenings. */
  rs: Cell[];
  /** The five derived technicals, at the grid's own date — they are computed from it. */
  signals: SignalCell[];
  /** The date `rs` is from. Null when RS could not be read or has no rows at all. */
  rsAsOf: string | null;
  /** Six months of market series for the history charts. Additive — a failure costs its own panel. */
  history: MarketHistoryRow[];
  historyError: string | null;
  /**
   * WHY THESE ARE SEPARATE FROM `error` AND NOT FOLDED INTO IT.
   *
   * `error` means the GRID could not be loaded and the page shows a panel instead of a table. The
   * market block and the RS column are additive: if either read fails, the right outcome is the
   * grid plus a line saying that block could not be read — not a blank page. The digest learned
   * this the hard way on 2026-09-15, where the fix was that an unread change list must never
   * render as a quiet day. Same rule, applied before it costs anything: an unread block says so.
   */
  marketError: string | null;
  rsError: string | null;
  signalsError: string | null;
  error: string | null;
}

function config(): { url: string; key: string } | null {
  // The URL is not a secret and may already exist under the NEXT_PUBLIC name from the
  // deployment-check page. The KEY has no such fallback, deliberately.
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ""), key };
}

async function get<T>(path: string, cfg: { url: string; key: string }): Promise<T> {
  const what = path.split("?")[0];
  let r: Response;
  try {
    r = await fetch(`${cfg.url}/rest/v1/${path}`, {
      headers: {
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
        Accept: "application/json",
      },
      next: { revalidate: REVALIDATE_SECONDS },
    });
  } catch (e) {
    // A network-level failure arrives as a bare "fetch failed" with no indication of what was
    // being fetched or from where, which is useless on a page whose whole job is to explain
    // itself. Name the request and the host - the host is not a secret, the key is, and the key
    // is never in the URL.
    const cause = e instanceof Error ? e.message : String(e);
    throw new Error(`${what}: could not reach ${new URL(cfg.url).host} (${cause})`);
  }
  if (!r.ok) {
    // The body can contain the failing SQL but never the key. Truncated so a long PostgREST
    // error cannot push the actual message off the page.
    const body = (await r.text()).slice(0, 300);
    throw new Error(`${what}: HTTP ${r.status} ${body}`);
  }
  return (await r.json()) as T;
}

/**
 * `get`, but a failure is a value rather than an exception. Used for the two ADDITIVE blocks, so
 * one of them being unavailable costs its own panel and not the whole page.
 */
async function tryGet<T>(
  path: string,
  cfg: { url: string; key: string },
): Promise<{ data: T | null; error: string | null }> {
  try {
    return { data: await get<T>(path, cfg), error: null };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function fetchGrid(): Promise<GridData> {
  const empty: GridData = {
    status: null,
    tickers: [],
    cells: [],
    norms: [],
    market: [],
    rs: [],
    signals: [],
    rsAsOf: null,
    history: [],
    historyError: null,
    marketError: null,
    rsError: null,
    signalsError: null,
    error: null,
  };

  const cfg = config();
  if (!cfg) {
    return {
      ...empty,
      error:
        "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not both set on this deployment. " +
        "Add them in the Vercel project settings — the key must NOT use the NEXT_PUBLIC_ prefix.",
    };
  }

  try {
    // Status first: it names the date everything else is filtered to, so the grid and the
    // freshness stamp can never disagree about which day is being shown.
    const status = (await get<Status[]>("grid_status?select=*", cfg))[0] ?? null;
    if (!status?.data_through) {
      return { ...empty, status, error: "No data yet — the ingest has not stored any bars." };
    }

    // The three reads the grid cannot render without, and the two it can. Both groups go out
    // together - they are independent reads against the same host - but only the first group can
    // fail the page.
    const [tickers, cells, norms, market, rsLatest, signals, history] = await Promise.all([
      get<Ticker[]>(
        "tickers?active=eq.true&is_index=eq.false&select=symbol,name,theme,bellwether,is_fund,rankable&order=theme.asc,symbol.asc",
        cfg,
      ),
      get<Cell[]>(
        `grid_cells?d=eq.${status.data_through}&select=symbol,param,value,verdict,has_norm,suppressed_warmup`,
        cfg,
      ),
      get<Norm[]>("norms?select=param,low,high&order=param.asc", cfg),
      tryGet<MarketCell[]>(
        `market_cells?d=eq.${status.data_through}&select=param,value,as_of,verdict,has_norm`,
        cfg,
      ),
      // RS is read at ITS OWN newest date, which is not the grid's. Asking the view for its max d
      // rather than deriving it from index_status: the two agree today, but one of them would be
      // an inference about how the other is built, and this is one cheap indexed read.
      tryGet<Array<{ d?: string }>>("rs_cells?select=d&order=d.desc&limit=1", cfg),
      // Signals share the grid's date - they are derived from daily_features, not borrowed from a
      // series on another clock - so they need no as-of of their own.
      tryGet<SignalCell[]>(
        `signal_cells?d=eq.${status.data_through}&select=symbol,param,label,value,tone,seed_ok`,
        cfg,
      ),
      // SIX MONTHS, NEWEST FIRST, THEN REVERSED HERE.
      //
      // `order=d.desc&limit=126` is an index scan on market_history_pk that stops after 126 rows.
      // The alternatives both cost more for nothing: `order=d.asc&limit=126` returns the OLDEST 126
      // rows of a five-year series, and a `d=gte.` filter needs a date this code would have to
      // compute from a calendar - and 126 TRADING bars is not six calendar months (decision 0035).
      // Charts need ascending order, so the reversal happens once, below, rather than in SQL.
      tryGet<MarketHistoryRow[]>(
        "market_history?select=d,vix,vix_band,vix3m,term_structure,spx_close,breadth_pct," +
          "breadth_tracked,vix_ma20,vix_ma20_bars&order=d.desc&limit=126",
        cfg,
      ),
    ]);

    const rsAsOf = rsLatest.data?.[0]?.d ?? null;
    const rs = rsAsOf
      ? await tryGet<Cell[]>(
        `rs_cells?d=eq.${rsAsOf}&select=symbol,param,value,verdict,has_norm,suppressed_warmup`,
        cfg,
      )
      : { data: [] as Cell[], error: rsLatest.error };

    return {
      status,
      tickers,
      cells,
      norms,
      market: market.data ?? [],
      rs: rs.data ?? [],
      signals: signals.data ?? [],
      // Reversed to ascending, which is what every chart wants. `slice()` first because the array
      // came from JSON.parse and reversing in place would be fine today and a trap the first time
      // anything else reads it.
      history: (history.data ?? []).slice().reverse(),
      historyError: history.error,
      rsAsOf,
      marketError: market.error,
      // An empty RS read with no error is a real state - the view genuinely has no rows - and must
      // not be reported as a failure. Only an actual error is one.
      rsError: rs.error ?? rsLatest.error,
      signalsError: signals.error,
      error: null,
    };
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * WHAT USED TO LIVE BELOW THIS LINE, and where it went on 2026-09-17.
 *
 * The column catalogue, the presets, the cell-state model and the formatters moved to
 * `lib/columns.ts`; the market tiles to `lib/market.ts`. Both are PURE - no fetch, no env var, no
 * secret - so the interactive table can import them in the browser.
 *
 * This file keeps only what needs the service_role key, which is the point: it is now the single
 * module a client component must never import, rather than a mixed bag where the rule was easy to
 * break by accident. `scripts/ci/check_web_boundary.sh` fails the build if a file containing
 * "use client" reaches it.
 */
