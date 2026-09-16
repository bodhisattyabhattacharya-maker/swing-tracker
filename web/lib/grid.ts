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

export interface GridData {
  status: Status | null;
  tickers: Ticker[];
  cells: Cell[];
  norms: Norm[];
  /** The market block. Empty with `marketError` set if it could not be read. */
  market: MarketCell[];
  /** Relative-strength cells at THEIR newest date, which trails the grid's most evenings. */
  rs: Cell[];
  /** The date `rs` is from. Null when RS could not be read or has no rows at all. */
  rsAsOf: string | null;
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
    rsAsOf: null,
    marketError: null,
    rsError: null,
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
    const [tickers, cells, norms, market, rsLatest] = await Promise.all([
      get<Ticker[]>(
        "tickers?active=eq.true&is_index=eq.false&select=symbol,name,theme,bellwether&order=theme.asc,symbol.asc",
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
      rsAsOf,
      marketError: market.error,
      // An empty RS read with no error is a real state - the view genuinely has no rows - and must
      // not be reported as a failure. Only an actual error is one.
      rsError: rs.error ?? rsLatest.error,
      error: null,
    };
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The column order of the grid, and the only place it is defined.
 *
 * `param` must match a parameter name in `grid_cells`. A typo here shows as a permanently blank
 * column rather than an error, which is why the set is small and explicit rather than derived.
 */
export type Timeframe = "daily" | "weekly" | "rs";

export interface Column {
  param: string;
  label: string;
  digits: number;
  signed: boolean;
  timeframe: Timeframe;
  /**
   * WHICH MAP THE VALUE COMES FROM, stated rather than inferred from `timeframe`.
   *
   * `grid_cells` and `rs_cells` are different views keyed on different dates, and the page holds
   * one lookup per view. Deriving this from `timeframe === "rs"` would work today and break the
   * day a weekly-RS column exists, silently reading the wrong map.
   */
  source: "cells" | "rs";
}

/**
 * WHY EVERY COLUMN CARRIES A TIMEFRAME, and why it is not fetched from the row.
 *
 * "vs 21 EMA" means two different numbers depending on whether the bars are days or weeks, and a
 * grid that shows both without saying which is one a reader can misread without noticing. The
 * header groups on this.
 *
 * `grid_cells` publishes a `timeframe` column too, but the page does not read it: the parameter
 * names are already globally unique, so the cell lookup cannot collide, and a column has to be
 * declared here to appear at all. The database column exists because the DIGEST filters on it,
 * which is where it is load-bearing.
 *
 * WEEKLY VALUES STEP ONCE A WEEK. They come from the last week that ended before the week you are
 * looking at, so they are identical Monday through Friday and change on the boundary. That is
 * correct - a weekly bar has one value - and it is why a weekly cell going from blue to plain
 * mid-week would be a bug rather than a move.
 */
export const COLUMNS: Column[] = [
  { param: "close", label: "Close", digits: 2, signed: false, timeframe: "daily", source: "cells" },
  { param: "rsi_daily", label: "RSI 14", digits: 1, signed: false, timeframe: "daily", source: "cells" },
  { param: "close_vs_ema21d", label: "vs 21 EMA", digits: 1, signed: true, timeframe: "daily", source: "cells" },
  { param: "close_vs_sma50d", label: "vs 50 SMA", digits: 1, signed: true, timeframe: "daily", source: "cells" },
  { param: "close_vs_sma200d", label: "vs 200 SMA", digits: 1, signed: true, timeframe: "daily", source: "cells" },
  { param: "pct_off_high_stored", label: "Off high", digits: 1, signed: true, timeframe: "daily", source: "cells" },
  { param: "pct_off_52w_high", label: "Off 52w high", digits: 1, signed: true, timeframe: "daily", source: "cells" },
  { param: "pct_above_low_stored", label: "Above low", digits: 1, signed: true, timeframe: "daily", source: "cells" },
  { param: "realized_vol_20", label: "Real vol 20", digits: 1, signed: false, timeframe: "daily", source: "cells" },
  { param: "volume_ratio", label: "Vol ratio", digits: 2, signed: false, timeframe: "daily", source: "cells" },

  // Uncoloured by design, both of them: close_vs_sma200w had a norm that flagged 87-90% of
  // name-weeks in every year we hold, and close_vs_sma30w has never had one measured.
  // config/norms.yml carries the reasoning.
  { param: "rsi_weekly", label: "RSI 14", digits: 1, signed: false, timeframe: "weekly", source: "cells" },
  { param: "close_vs_ema21w", label: "vs 21 EMA", digits: 1, signed: true, timeframe: "weekly", source: "cells" },
  { param: "close_vs_sma30w", label: "vs 30W SMA", digits: 1, signed: true, timeframe: "weekly", source: "cells" },
  { param: "close_vs_sma200w", label: "vs 200W SMA", digits: 1, signed: true, timeframe: "weekly", source: "cells" },

  /**
   * Relative strength. ONE window on the grid, not three: 63b and 252b are computed, published by
   * `rs_cells` and one line each to add here - but the table is already fourteen columns wide and
   * a parameter nobody has lived with yet does not get three of them.
   *
   * `rs_vs_spx_126b` is the norm key too. It used to be `rs_vs_spx_6m`, which matched no parameter
   * and therefore coloured nothing at all; renamed in decision 0038 precisely so this column could
   * be judged rather than merely displayed.
   */
  { param: "rs_vs_spx_126b", label: "vs SPX 126b", digits: 1, signed: true, timeframe: "rs", source: "rs" },
];

/**
 * Column groups in order, for the grid's two-row header. Derived, so it cannot drift.
 *
 * The RS group's label carries ITS OWN DATE whenever that date is not the grid's. Most weekday
 * evenings it is not: `relative_strength` only publishes on dates where SPX also has a bar, and
 * FRED publishes hours after the equities do, so between the 22:30 ingest and the 11:00 catch-up
 * the newest RS row is one session behind everything else on the page.
 *
 * Showing the number and naming its date is the same treatment `market_cells` gives VIX and SPX,
 * and it is decision 0034's rule: every borrowed value carries its own date. The alternative
 * considered and rejected was a blank column until the catch-up filled it — strictly honest, and
 * empty exactly when someone is most likely to be looking.
 *
 * When the dates match, the label says nothing extra. A date that is always displayed stops being
 * read, and the one that matters is the one that differs.
 */
export function columnGroups(
  opts: { gridDate?: string | null; rsAsOf?: string | null } = {},
): Array<{ timeframe: Timeframe; label: string; span: number }> {
  const out: Array<{ timeframe: Timeframe; label: string; span: number }> = [];
  for (const c of COLUMNS) {
    const last = out[out.length - 1];
    if (last && last.timeframe === c.timeframe) last.span += 1;
    else out.push({ timeframe: c.timeframe, label: groupLabel(c.timeframe, opts), span: 1 });
  }
  return out;
}

function groupLabel(
  tf: Timeframe,
  { gridDate, rsAsOf }: { gridDate?: string | null; rsAsOf?: string | null },
): string {
  if (tf === "weekly") return "Weekly — last completed week";
  if (tf !== "rs") return "Daily";
  // Short on purpose. A group header is `white-space: nowrap` and this group has ONE column, so the
  // label sets that column's minimum width: "Relative strength — vs S&P 500, as of 2026-09-14" made
  // it ~350px wide with the number marooned at the far right. The date moved to the column's own
  // sub-line (see rsAsOfNote), which is where per-column metadata already lives, and "vs S&P 500"
  // was redundant with the column label "vs SPX 126b".
  return "Relative strength";
}

/**
 * The line under the RS column heading, where the norm sits for every other column.
 *
 * Empty when RS is as current as the grid — a date shown every day stops being read, and the one
 * that matters is the one that differs. Most weekday evenings it does differ, by one session,
 * because SPX arrives from FRED hours after the equities.
 */
export function rsAsOfNote(gridDate: string | null, rsAsOf: string | null): string {
  if (!rsAsOf) return "not yet computable";
  return rsAsOf === gridDate ? "" : `as of ${rsAsOf}`;
}

/**
 * The market block, in order. Four numbers about the market rather than about any name, which is
 * why they sit above the grid and not in it.
 *
 * `suffix` rather than a unit column: these are read at a glance and "12.7%" is one token where
 * "12.7" under a "%" heading is two. `hint` is the one-line reason the number is on the page at
 * all - the block is small enough that explaining it costs nothing and large enough that a reader
 * who has not thought about term structure in a year needs it.
 */
export const MARKET_TILES: Array<{
  param: string;
  label: string;
  digits: number;
  signed: boolean;
  suffix: string;
  hint: string;
}> = [
  { param: "vix", label: "VIX", digits: 2, signed: false, suffix: "",
    hint: "16–30 is the band we hedge in; above it is where scaling out gets considered." },
  { param: "term_structure", label: "VIX term structure", digits: 1, signed: true, suffix: "%",
    hint: "3-month VIX over spot. Negative is backwardation — the market pricing near-term stress." },
  { param: "spx_close", label: "S&P 500", digits: 2, signed: false, suffix: "",
    hint: "The base every relative-strength number on the grid is measured against." },
  { param: "breadth_pct", label: "Breadth", digits: 0, signed: false, suffix: "%",
    hint: "Share of the watchlist above its own 50-day average. Not the market's breadth — ours." },
];

/** Display names for watchlist themes. An unmapped theme falls back to its raw key, visibly. */
export const THEME_LABELS: Record<string, string> = {
  "ai-infrastructure": "AI infrastructure",
  "ai-silicon": "AI silicon",
  "diversified": "Diversified",
  "foundry-analog-ip": "Foundry, analog & IP",
  "mega-cap-tech": "Mega-cap tech",
  "memory-storage": "Memory & storage",
  "semi-equipment": "Semi equipment",
};

export function formatValue(v: number | null, digits: number, signed: boolean): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const s = v.toFixed(digits);
  return signed && v > 0 ? `+${s}` : s;
}

/** "30 · 70", "−30", "" — the norm as it is shown under a column heading. */
export function formatNorm(n: Norm | undefined): string {
  if (!n) return "";
  const lo = n.low === null ? null : String(n.low);
  const hi = n.high === null ? null : String(n.high);
  if (lo !== null && hi !== null) return `${lo} · ${hi}`;
  return lo ?? hi ?? "";
}
