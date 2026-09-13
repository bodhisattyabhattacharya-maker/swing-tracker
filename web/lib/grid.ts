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

export interface Status {
  data_through: string | null;
  symbols: number | null;
  /** Published as a fact, NOT as the verdict — a market holiday is not a failed pipeline. */
  days_behind: number | null;
  /** Hours since the daily ingest last completed successfully. null means it never has. */
  hours_since_success: number | null;
  last_success_at: string | null;
  stale_after_hours: number | null;
  /** The verdict, and it measures the PIPELINE. See the grid_status view header. */
  is_stale: boolean | null;
  /** The LAST run, which is a different question from the last GOOD run — showing both is what
   *  distinguishes "nothing has run" from "it ran and failed". */
  last_run_at: string | null;
  last_run_ok: boolean | null;
  last_run_by: string | null;
}

export interface Norm {
  param: string;
  low: number | null;
  high: number | null;
}

export interface GridData {
  status: Status | null;
  tickers: Ticker[];
  cells: Cell[];
  norms: Norm[];
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

export async function fetchGrid(): Promise<GridData> {
  const empty: GridData = { status: null, tickers: [], cells: [], norms: [], error: null };

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

    const [tickers, cells, norms] = await Promise.all([
      get<Ticker[]>(
        "tickers?active=eq.true&is_index=eq.false&select=symbol,name,theme,bellwether&order=theme.asc,symbol.asc",
        cfg,
      ),
      get<Cell[]>(
        `grid_cells?d=eq.${status.data_through}&select=symbol,param,value,verdict,has_norm,suppressed_warmup`,
        cfg,
      ),
      get<Norm[]>("norms?select=param,low,high&order=param.asc", cfg),
    ]);

    return { status, tickers, cells, norms, error: null };
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
export const COLUMNS: Array<{ param: string; label: string; digits: number; signed: boolean }> = [
  { param: "close", label: "Close", digits: 2, signed: false },
  { param: "rsi_daily", label: "RSI 14", digits: 1, signed: false },
  { param: "close_vs_ema21d", label: "vs 21 EMA", digits: 1, signed: true },
  { param: "close_vs_sma50d", label: "vs 50 SMA", digits: 1, signed: true },
  { param: "close_vs_sma200d", label: "vs 200 SMA", digits: 1, signed: true },
  { param: "pct_off_high_stored", label: "Off high", digits: 1, signed: true },
  { param: "pct_off_52w_high", label: "Off 52w high", digits: 1, signed: true },
  { param: "pct_above_low_stored", label: "Above low", digits: 1, signed: true },
  { param: "realized_vol_20", label: "Real vol 20", digits: 1, signed: false },
  { param: "volume_ratio", label: "Vol ratio", digits: 2, signed: false },
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
