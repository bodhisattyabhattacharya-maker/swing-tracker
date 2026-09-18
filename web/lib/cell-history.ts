/**
 * cell-history.ts — the contract for "one parameter's history for one security".
 *
 * PURE. No fetch, no env var, no secret — both the client sheet and the route handler import it,
 * which is only safe because it stays that way. `check_web_boundary.sh` rule 2 enforces it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE FILE AND NOT TWO COPIES OF A STRING
 *
 * The browser asks for a series; a server route answers. Those are two programs, and the one thing
 * that must never drift between them is WHAT IS ALLOWED TO BE ASKED. `symbol` and `param` end up in
 * a PostgREST URL constructed with the service_role key, so the allowlist is not a convenience — it
 * is the difference between an endpoint that serves one chart and an endpoint that proxies a
 * database on a public repo.
 *
 * So the allowlist is derived from `COLUMNS`, the catalogue the grid already renders from. A param
 * the grid does not display cannot be requested, by construction rather than by review.
 */

import { COLUMNS, type Source } from "./columns";

/** Which view a param's history comes from. Mirrors `Column.source` for the readable sources. */
export type HistorySource = "cells" | "rs" | "signals";

export interface HistoryPoint {
  d: string;
  value: number | null;
  verdict?: "below" | "normal" | "above" | null;
  /** Signal params carry a label instead of a number. */
  label?: string | null;
  tone?: string | null;
}

export interface HistoryResult {
  symbol: string;
  param: string;
  points: HistoryPoint[];
  /** Set when the read failed. The sheet renders the sentence, never an empty chart. */
  error: string | null;
  /** True when the param is real but has no history view yet (a planned column). */
  unbuilt?: boolean;
}

/**
 * The params whose history can be asked for, and where each one lives.
 *
 * Built from `COLUMNS` at module load. Only `live` columns are included: a `planned` column has no
 * rows anywhere, and letting it through would turn "not built" into an empty chart, which is the
 * distinction the whole cell-state model exists to preserve.
 *
 * `fundamentals` and `forward` sources are excluded because those views do not exist yet. When they
 * land they become readable by adding them here and nowhere else.
 */
export const HISTORY_PARAMS: ReadonlyMap<string, HistorySource> = new Map(
  COLUMNS
    .filter((c) => c.status === "live")
    .filter((c): c is typeof c & { source: HistorySource } =>
      c.source === "cells" || c.source === "rs" || c.source === "signals"
    )
    .map((c) => [c.param, c.source] as const),
);

/** Params that exist in the catalogue but have no history to read. Used to answer honestly. */
export const UNBUILT_PARAMS: ReadonlySet<string> = new Set(
  COLUMNS.filter((c) => c.status === "planned").map((c) => c.param),
);

/**
 * A symbol is a ticker: upper-case letters, digits, dots and dashes, at most 8 characters.
 *
 * Validated by SHAPE here and by existence in the database there. Both, not either: the shape check
 * is what keeps anything odd out of a URL, and the existence check is what stops this endpoint
 * confirming or denying tickers we do not track.
 */
const SYMBOL_RE = /^[A-Z][A-Z0-9.\-^]{0,7}$/;

export function isSymbolShape(s: string): boolean {
  return SYMBOL_RE.test(s);
}

export type Rejection =
  | { ok: false; status: 400; message: string }
  | { ok: false; status: 404; message: string };

export type Acceptance = { ok: true; symbol: string; param: string; source: HistorySource };

/**
 * Validate a request. The route handler calls this and touches the database only on `ok: true`.
 *
 * Returns the resolved source rather than a boolean, so the caller cannot accidentally decide for
 * itself which view to read — the mapping lives here, next to the allowlist it came from.
 */
export function validateRequest(
  symbolRaw: string | null,
  paramRaw: string | null,
): Acceptance | Rejection {
  const symbol = (symbolRaw ?? "").trim().toUpperCase();
  const param = (paramRaw ?? "").trim();

  if (!symbol || !param) {
    return { ok: false, status: 400, message: "both symbol and param are required" };
  }
  if (!isSymbolShape(symbol)) {
    return { ok: false, status: 400, message: "symbol is not a ticker" };
  }
  if (UNBUILT_PARAMS.has(param)) {
    return {
      ok: false,
      status: 404,
      // 404 and not 400: the param is spelled correctly and is in the catalogue. Saying "unknown
      // parameter" here would be wrong and would send someone looking for a typo.
      message: "this parameter is designed and not built, so it has no history",
    };
  }
  const source = HISTORY_PARAMS.get(param);
  if (!source) {
    return { ok: false, status: 400, message: "unknown parameter" };
  }
  return { ok: true, symbol, param, source };
}

/**
 * How many rows one request may return.
 *
 * Five years of daily bars is ~1,260, and the paid plan carries five years, so this is the whole
 * history rather than a window — the sheet's job is to show where today sits in the range it has.
 * The cap exists so the number is bounded by a constant rather than by however much history the
 * plan grows to hold.
 */
export const MAX_POINTS = 1400;

/** The columns each view is asked for. Fixed strings, never built from request input. */
export const SELECT: Record<HistorySource, string> = {
  cells: "d,value,verdict",
  rs: "d,value,verdict",
  signals: "d,value,label,tone",
};

export const VIEW: Record<HistorySource, string> = {
  cells: "grid_cells",
  rs: "rs_cells",
  signals: "signal_cells",
};

/** The endpoint, in one place, so the client and any test agree on it. */
export function historyUrl(symbol: string, param: string): string {
  const q = new URLSearchParams({ symbol, param });
  return `/api/cell-history?${q.toString()}`;
}

/** First and last dates plus the count, for the line under the chart. */
export function describe(points: HistoryPoint[]): string {
  const withValues = points.filter((p) => p.value !== null && p.value !== undefined);
  if (points.length === 0) return "no history";
  const head = points[0].d;
  const tail = points[points.length - 1].d;
  const gaps = points.length - withValues.length;
  return `${head} → ${tail} · ${points.length} sessions` +
    (gaps > 0 ? ` · ${gaps} without a value, drawn as gaps` : "");
}

/** Unused re-export kept so a test can assert the allowlist is derived, not hand-written. */
export type { Source };
