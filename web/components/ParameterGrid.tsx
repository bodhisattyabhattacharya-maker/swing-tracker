"use client";

/**
 * ParameterGrid — the Dashboard table.
 *
 * THE FIRST CLIENT COMPONENT IN THIS APP, AND THE REASON THE BOUNDARY IS NOW ENFORCED.
 *
 * Presets, sorting, filtering, collapsing a theme and opening a cell all have to feel instant; a
 * server round-trip per click would make a dense table feel broken. So this runs in the browser —
 * which means everything it imports is in the browser bundle.
 *
 * It imports `lib/columns.ts`, which is pure configuration: no fetch, no env var, no secret.
 * It must NEVER import `lib/grid.ts`, which holds the service_role key. The repo is public, so a
 * key that reaches the bundle is a key that is gone permanently. `scripts/ci/check_web_boundary.sh`
 * fails the build on that import rather than trusting this comment.
 *
 * Rows arrive as PROPS. Data crossing the boundary is fine and is the whole design; the module
 * that can fetch it must not cross.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * No score, no ranking, no composite. Every column is independently sorted and independently
 * coloured against its own norm. Colour expresses a relationship to a threshold we set, never a
 * recommendation — which is why the palette is blue and ochre rather than red and green.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  COLOURED,
  type CellLike,
  type CellState,
  type Column,
  cellState,
  columnsFor,
  formatNorm,
  formatValue,
  groupStarts,
  headerGroups,
  type PresetKey,
  PRESETS,
  type Security,
  THEME_LABELS,
  TIMEFRAME_LABELS,
} from "../lib/columns";

export interface GridRow extends Security {
  name: string;
  theme: string;
  bellwether: boolean;
}

export interface Norm {
  param: string;
  low: number | null;
  high: number | null;
}

export interface Props {
  rows: GridRow[];
  /** Keyed `symbol|param`, merged across grid_cells, rs_cells and signal_cells by the server. */
  cells: Record<string, CellLike>;
  norms: Norm[];
  /** Shown under the Relative group when RS trails the grid's date, which is most evenings. */
  rsAsOf: string | null;
  gridDate: string | null;
  /** One line per additive block that could not be read. Never rendered as absent data. */
  unavailable: string[];
}

type SortDir = "asc" | "desc";

/**
 * Sort order for the states that have no number. They always sort AFTER real values, in both
 * directions, because "no value" is not small and is not large — putting nulls at one end would
 * make a descending sort claim they are the smallest thing on the grid.
 */
const STATE_RANK: Record<CellState, number> = {
  below: 0, normal: 0, above: 0, "no-norm": 0, warmup: 0,
  null: 1, na: 2, planned: 3,
};

export default function ParameterGrid(
  { rows, cells, norms, rsAsOf, gridDate, unavailable }: Props,
) {
  const [preset, setPreset] = useState<PresetKey>("momentum");
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ param: string; dir: SortDir } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<{ symbol: string; col: Column } | null>(null);

  const columns = useMemo(() => columnsFor(preset), [preset]);

  // -------------------------------------------------------------------------
  // THE RIGHT-EDGE SCRIM: "there is more table past this edge".
  //
  // A class on the wrapper, not React state, and on purpose: this fires on every scroll frame, and
  // setState there would re-render the whole table — 22 rows x 16 columns, and 52 columns in the
  // All preset — sixty times a second for a 40px gradient. The DOM is the right place for a purely
  // visual flag that no other code reads.
  //
  // There is no left-hand counterpart. See the stylesheet: on the left it would sit over the row's
  // own identity, which is the one thing on this table that must never be obscured.
  // -------------------------------------------------------------------------
  const wrapRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const syncEdge = useCallback(() => {
    const wrap = wrapRef.current;
    const sc = scrollRef.current;
    if (!wrap || !sc) return;
    const slack = sc.scrollWidth - sc.clientWidth;
    // 2px, not 0: sub-pixel layout leaves a fraction of scrollWidth over at the true end, and a
    // scrim that never quite goes out is one nobody believes.
    wrap.classList.toggle("more-r", slack > 2 && sc.scrollLeft < slack - 2);
  }, []);

  // Runs after the first paint, and again whenever the table's width changes - switching preset
  // from Momentum to All takes it from 1859px to 6142px, and a scrim left over from the previous
  // set would be a claim about the new one that nobody measured.
  useEffect(() => {
    syncEdge();
    const ro = new ResizeObserver(syncEdge);
    if (scrollRef.current) ro.observe(scrollRef.current);
    const t = scrollRef.current?.querySelector("table");
    if (t) ro.observe(t);
    window.addEventListener("resize", syncEdge);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", syncEdge);
    };
  }, [syncEdge]);
  const groups = useMemo(() => headerGroups(columns), [columns]);
  const starts = useMemo(() => groupStarts(columns), [columns]);
  const normByParam = useMemo(
    () => new Map(norms.map((n) => [n.param, n])),
    [norms],
  );

  // Filter matches symbol OR company name, and deliberately does not dissolve the theme grouping:
  // a filtered view that flattened the groups would change what the reader is looking at.
  const q = filter.trim().toLowerCase();
  const visible = useMemo(
    () =>
      q
        ? rows.filter((r) =>
          r.symbol.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)
        )
        : rows,
    [rows, q],
  );

  // Sorting happens WITHIN a theme. Group order never moves — that is the reader's map of the page.
  const byTheme = useMemo(() => {
    const m = new Map<string, GridRow[]>();
    for (const r of visible) {
      if (!m.has(r.theme)) m.set(r.theme, []);
      m.get(r.theme)!.push(r);
    }
    if (sort) {
      const col = columns.find((c) => c.param === sort.param);
      for (const list of m.values()) {
        list.sort((a, b) => {
          if (!col) return 0;
          const ca = cells[`${a.symbol}|${col.param}`];
          const cb = cells[`${b.symbol}|${col.param}`];
          const sa = STATE_RANK[cellState(col, a, ca)];
          const sb = STATE_RANK[cellState(col, b, cb)];
          if (sa !== sb) return sa - sb;
          if (sa !== 0) return a.symbol.localeCompare(b.symbol);
          const va = ca?.value ?? 0;
          const vb = cb?.value ?? 0;
          return sort.dir === "asc" ? va - vb : vb - va;
        });
      }
    }
    return m;
  }, [visible, sort, columns, cells]);

  const themeOrder = useMemo(() => [...new Set(rows.map((r) => r.theme))], [rows]);

  function toggleSort(param: string) {
    setSort((s) =>
      s?.param === param
        ? (s.dir === "desc" ? { param, dir: "asc" } : null)
        : { param, dir: "desc" }
    );
  }

  function toggleTheme(theme: string) {
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(theme)) next.delete(theme);
      else next.add(theme);
      return next;
    });
  }

  return (
    <>
      <div className="controls">
        <input
          className="find"
          placeholder="Filter symbol or company…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter by symbol or company"
        />
        <div className="presets" role="tablist" aria-label="Column preset">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              role="tab"
              aria-selected={preset === p.key}
              className={preset === p.key ? "seg on" : "seg"}
              onClick={() => setPreset(p.key)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <span className="hint">
          Tap a header to sort within themes · tap a value for its definition
        </span>
      </div>

      {unavailable.length > 0
        ? (
          <div className="banner stale">
            <b>{unavailable.join(" and ")} could not be read.</b>{" "}
            Those columns are blank below for that reason, not because the numbers are missing.
            Everything else on this page is current.
          </div>
        )
        : null}

      <div className="scrollwrap" ref={wrapRef}>
        {/* Always in the DOM and starts hidden; `syncEdge` turns it on only when there is content
            past the right edge. Rendering it conditionally would make the first paint depend on a
            measurement the server cannot take. */}
        <span className="fade r" aria-hidden="true" />
        <div className="scroll" ref={scrollRef} onScroll={syncEdge}>
        <table>
          <thead>
            <tr className="grp">
              <th className="sym" />
              {groups.map((g, i) => (
                <th key={`${g.key}-${i}`} colSpan={g.span} className={g.key}>
                  {g.label}
                  {g.key === "relative" && rsAsOf && rsAsOf !== gridDate
                    ? <span className="asof">as of {rsAsOf}</span>
                    : null}
                </th>
              ))}
            </tr>
            <tr>
              <th className="sym">Symbol</th>
              {columns.map((c) => {
                const n = normByParam.get(c.param);
                const tf = TIMEFRAME_LABELS[c.timeframe];
                const active = sort?.param === c.param;
                return (
                  <th
                    key={c.param}
                    className={starts.has(c.param) ? "grp-start" : undefined}
                    aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"}
                  >
                    <button className="sorter" onClick={() => toggleSort(c.param)}>
                      {c.label}
                      {tf ? <span className="tf">{tf}</span> : null}
                      {active ? <span className="dir">{sort!.dir === "asc" ? "↑" : "↓"}</span> : null}
                    </button>
                    {n ? <span className="norm">{formatNorm(n)}</span> : null}
                    {c.status === "planned" ? <span className="norm plan">planned</span> : null}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {themeOrder.map((theme) => {
              const list = byTheme.get(theme);
              if (!list || list.length === 0) return null;
              const isCollapsed = collapsed.has(theme);
              return (
                <Theme
                  key={theme}
                  theme={theme}
                  list={list}
                  collapsed={isCollapsed}
                  columns={columns}
                  cells={cells}
                  starts={starts}
                  onToggle={() => toggleTheme(theme)}
                  onOpen={(symbol, col) => setOpen({ symbol, col })}
                />
              );
            })}
          </tbody>
        </table>
        </div>
      </div>

      {open
        ? (
          <CellSheet
            symbol={open.symbol}
            col={open.col}
            row={rows.find((r) => r.symbol === open.symbol)!}
            cell={cells[`${open.symbol}|${open.col.param}`]}
            norm={normByParam.get(open.col.param)}
            onClose={() => setOpen(null)}
          />
        )
        : null}
    </>
  );
}

function Theme(
  { theme, list, collapsed, columns, cells, starts, onToggle, onOpen }: {
    theme: string;
    list: GridRow[];
    collapsed: boolean;
    columns: Column[];
    cells: Record<string, CellLike>;
    starts: Set<string>;
    onToggle: () => void;
    onOpen: (symbol: string, col: Column) => void;
  },
) {
  return (
    <>
      <tr className="band">
        <td colSpan={columns.length + 1}>
          <button className="bandbtn" onClick={onToggle} aria-expanded={!collapsed}>
            <span className="chev">{collapsed ? "▸" : "▾"}</span>
            {THEME_LABELS[theme] ?? theme}
            <span className="n">{list.length} {list.length === 1 ? "name" : "names"}</span>
          </button>
        </td>
      </tr>
      {collapsed ? null : list.map((r) => (
        <tr key={r.symbol}>
          <td className="sym">
            {r.symbol}
            {r.bellwether ? <span className="bell" title="Bellwether">◆</span> : null}
            <span className="co">{r.name}</span>
          </td>
          {columns.map((c) => {
            const cell = cells[`${r.symbol}|${c.param}`];
            const state = cellState(c, r, cell);
            return (
              <Cell
                key={c.param}
                col={c}
                cell={cell}
                state={state}
                grpStart={starts.has(c.param)}
                onOpen={() => onOpen(r.symbol, c)}
              />
            );
          })}
        </tr>
      ))}
    </>
  );
}

/**
 * One cell. The state decides the treatment; the value is secondary to it.
 *
 * A chip renders its label with the number beside it — "Golden 88d", "Rising +0.6%/wk" — because
 * the two are one fact. A number renders alone. Neither ever gets an arrow, a rank or a word like
 * "buy": colour here means "outside a threshold you set", nothing more.
 */
function Cell(
  { col, cell, state, grpStart, onOpen }: {
    col: Column;
    cell: CellLike | undefined;
    state: CellState;
    grpStart: boolean;
    onOpen: () => void;
  },
) {
  const cls = [
    "cell",
    `st-${state}`,
    COLOURED.has(state) ? "mark" : "",
    grpStart ? "grp-start" : "",
  ].filter(Boolean).join(" ");

  let body: React.ReactNode;
  // PLANNED IS MARKED IN THE HEADER, NOT IN EVERY CELL (Bodhi, 2026-09-18).
  //
  // The cell used to carry a lavender "PLANNED" tag of its own. Correct per row, and unreadable in
  // bulk: the Value preset is 27 unbuilt columns, so 312 tags filled the screen at once and the
  // page read as a placeholder rather than as a tracker with work outstanding.
  //
  // The tag is safe to drop because a planned column is planned for EVERY row - the statement is
  // about the column, and the column heading is where a statement about a column belongs. Nothing
  // is lost that the reader cannot see from the same screen. `n·a` keeps its own mark, because that
  // one varies row by row and no header can carry it.
  //
  // The cell keeps its `st-planned` class, so the state model is unchanged and the detail sheet
  // still names the state in words when the cell is opened.
  if (state === "planned") body = <span className="dash" title="Not built yet — see the column heading">—</span>;
  else if (state === "na") body = <span className="tag na" title="Does not apply to this security">n·a</span>;
  else if (state === "null") body = <span className="dash">—</span>;
  else if (col.render === "chip") {
    body = (
      <>
        <span className="chip">{cell?.label}</span>
        {cell?.value !== null && cell?.value !== undefined
          ? (
            <span className="chipnum">
              {formatValue(cell.value, col.digits, col.signed)}
              {col.suffix ?? ""}
            </span>
          )
          : null}
      </>
    );
  } else if (col.render === "sparkline") body = <span className="dash">—</span>;
  else {
    body = (
      <>
        {formatValue(cell?.value, col.digits, col.signed)}
        {col.suffix ? <span className="unit">{col.suffix}</span> : null}
        {state === "warmup" ? <span className="warm" title="Inside its warm-up window — shown, never judged">*</span> : null}
      </>
    );
  }

  return (
    <td className={cls}>
      <button className="cellbtn" onClick={onOpen}>{body}</button>
    </td>
  );
}

/**
 * The cell detail sheet. Opens over the table without leaving it, per the spec.
 *
 * The five-year history chart lands with `grid_cell_history` in a later pass; until then this
 * shows what it honestly can — the metric's meaning, its band, and this cell's state — and says
 * that the history is not wired rather than drawing an empty frame that looks broken.
 */
function CellSheet(
  { symbol, col, row, cell, norm, onClose }: {
    symbol: string;
    col: Column;
    row: GridRow;
    cell: CellLike | undefined;
    norm: Norm | undefined;
    onClose: () => void;
  },
) {
  const state = cellState(col, row, cell);
  const reason: Record<CellState, string> = {
    planned: "This parameter is not built yet. No security has a value for it.",
    na: row.is_fund
      ? "An ETF has no financial statements, so this question does not apply to it."
      : "This theme is not a peer group, so a percentile inside it would not mean anything.",
    null: "No valid value for this security on this date.",
    warmup: "Computed, but still partly its own seed value. Shown, never judged.",
    "no-norm": "Tracked, with no threshold set. We have no opinion on this number.",
    below: "Below the low bound of its norm.",
    above: "Above the high bound of its norm.",
    normal: "Inside its norm.",
  };

  return (
    <div className="sheetwrap" onClick={onClose} role="dialog" aria-modal="true">
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheethead">
          <div>
            <h3>{symbol} · {col.label}</h3>
            <p className="muted">{row.name}</p>
          </div>
          <button className="x" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="sheetstats">
          <div>
            <span className="k">Current value</span>
            <span className="v">
              {col.render === "chip"
                ? (cell?.label ?? "—")
                : formatValue(cell?.value, col.digits, col.signed) + (col.suffix ?? "")}
            </span>
          </div>
          <div>
            <span className="k">Norm band</span>
            <span className="v">{norm ? formatNorm(norm) : "no norm set"}</span>
          </div>
          <div>
            <span className="k">State</span>
            <span className="v">{state}</span>
          </div>
        </div>

        <p className="why">{reason[state]}</p>
        {col.hint ? <p className="why muted">{col.hint}</p> : null}

        <p className="note">
          {/* No backticks in UI copy. They are not markdown here — they render as literal
              backticks, which looks like a template that failed to interpolate. */}
          Five-year history for this cell is not wired yet. It arrives with the{" "}
          <code>grid_cell_history</code> view; an empty chart frame here would read as a loading
          failure rather than as work not done.
        </p>
      </div>
    </div>
  );
}
