"use client";

/**
 * StockStrip — the Deep Dive tab: one analysis column per stock, side by side.
 *
 * A CLIENT COMPONENT, for the filter and the scroll-edge scrim. It imports `lib/columns.ts` and
 * `lib/deep-dive.ts`, both pure. It must NEVER import `lib/grid.ts`, which holds the service_role
 * key; rows arrive as props. `scripts/ci/check_web_boundary.sh` fails the build on that import
 * rather than trusting this line.
 *
 * ---------------------------------------------------------------------------
 * WHY A HORIZONTAL STRIP AND NOT A SELECTED-STOCK PAGE
 *
 * The obvious build is a dropdown and one stock's page. The spec asks for the strip instead, and
 * the reason is the same one that makes the Dashboard a grid: comparison. Every section sits at the
 * same height and the same width on every name, so the eye travels sideways and reads one thing
 * across the watchlist — which RSI gauges are pinned, which stacks are full bull. A dropdown makes
 * that a memory exercise. So the columns are a fixed 420px and the strip NEVER collapses into a
 * vertical stack, at any width. On a narrow screen it scrolls; it does not reflow.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * No score, no ranking, no composite, and no ordering by any parameter — `stripOrder` sorts by
 * theme and then alphabetically for exactly that reason. Colour means "outside a threshold you
 * set", which is why the palette is blue and ochre rather than red and green. A section that cannot
 * render says which of three things is stopping it, in words, and never shows an empty frame.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import StockChart from "./StockChart";
import {
  COLOURED,
  type CellLike,
  type CellState,
  cellState,
  type Column,
  formatNorm,
  formatValue,
  THEME_LABELS,
  TIMEFRAME_LABELS,
} from "../lib/columns";
import {
  barGeometry,
  COLUMN_WIDTH,
  gaugeGeometry,
  RESOLVED,
  type ResolvedSection,
  RS_BAR_LIMIT,
  sectionRender,
  type StripSecurity,
  stripOrder,
  themeStarts,
} from "../lib/deep-dive";

export interface Norm {
  param: string;
  low: number | null;
  high: number | null;
}

export interface Props {
  rows: StripSecurity[];
  /** Keyed `SYMBOL|param`, merged from the three cell views by the page. */
  cells: Record<string, CellLike>;
  norms: Norm[];
  gridDate: string | null;
  /** The date the RS numbers are from, which trails the grid's most evenings. */
  rsAsOf: string | null;
  /** Named blocks that could not be read, so a blank section is not mistaken for missing data. */
  unavailable: string[];
  /** Symbols with no bar on `gridDate` — their price cells are older than the rest of the page. */
  behind: string[];
}

export default function StockStrip(
  { rows, cells, norms, gridDate, rsAsOf, unavailable, behind }: Props,
) {
  const [filter, setFilter] = useState("");
  const normByParam = useMemo(() => new Map(norms.map((n) => [n.param, n])), [norms]);
  const behindSet = useMemo(() => new Set(behind), [behind]);

  const ordered = useMemo(() => stripOrder(rows), [rows]);
  const q = filter.trim().toLowerCase();
  const visible = useMemo(
    () =>
      q
        ? ordered.filter((r) =>
          r.symbol.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)
        )
        : ordered,
    [ordered, q],
  );
  const starts = useMemo(() => themeStarts(visible), [visible]);

  // ---------------------------------------------------------------------
  // The right-edge scrim, and it is the same mechanism as the grid's.
  //
  // classList on a ref, NOT setState: this fires on every scroll frame across a 22,000px strip,
  // and a re-render per frame on a DOM this size is visible stutter. The element is always in the
  // markup and starts hidden, because rendering it conditionally would make the first paint depend
  // on a measurement the server cannot take.
  //
  // A DARKENING, NOT A FADE TO THE SURFACE COLOUR. The grid learned this on 2026-09-18: a gradient
  // to `--surface` over a panel erases the text under it instead of suggesting more content.
  // ---------------------------------------------------------------------
  const scrollRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const syncEdge = useCallback(() => {
    const el = scrollRef.current;
    const wrap = wrapRef.current;
    if (!el || !wrap) return;
    const more = el.scrollWidth - el.clientWidth - el.scrollLeft > 2;
    wrap.classList.toggle("more-r", more);
  }, []);

  useEffect(() => {
    syncEdge();
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(syncEdge);
    ro.observe(el);
    return () => ro.disconnect();
  }, [syncEdge, visible.length]);

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
        <span className="hint">
          {visible.length} of {rows.length} names · scroll sideways · every column is the same
          {" "}{COLUMN_WIDTH}px so sections line up across names
        </span>
      </div>

      {unavailable.length > 0
        ? (
          <div className="banner stale">
            <b>{unavailable.join(" and ")} could not be read.</b>{" "}
            Those sections are blank below for that reason, not because the numbers are missing.
            Everything else on this page is current.
          </div>
        )
        : null}

      {visible.length === 0
        ? (
          <p className="note">
            No name matches “{filter}”. The filter reads the symbol and the company name; it does
            not search parameters.
          </p>
        )
        : (
          <div className="dd-wrap" ref={wrapRef}>
            <span className="dd-fade r" aria-hidden="true" />
            <div className="dd-scroll" ref={scrollRef} onScroll={syncEdge}>
              <div className="dd-strip">
                {visible.map((r) => (
                  <StockColumn
                    key={r.symbol}
                    sec={r}
                    cells={cells}
                    normByParam={normByParam}
                    themeStart={starts.has(r.symbol)}
                    rsAsOf={rsAsOf}
                    gridDate={gridDate}
                    isBehind={behindSet.has(r.symbol)}
                  />
                ))}
              </div>
            </div>
          </div>
        )}
    </>
  );
}

/** One stock's column: a header, then the eight sections in order. */
function StockColumn(
  { sec, cells, normByParam, themeStart, rsAsOf, gridDate, isBehind }: {
    sec: StripSecurity;
    cells: Record<string, CellLike>;
    normByParam: Map<string, Norm>;
    themeStart: boolean;
    rsAsOf: string | null;
    gridDate: string | null;
    isBehind: boolean;
  },
) {
  return (
    <article
      className={themeStart ? "dd-col theme-start" : "dd-col"}
      style={{ width: COLUMN_WIDTH, minWidth: COLUMN_WIDTH }}
    >
      <header className="dd-head">
        <div className="dd-sym">
          {sec.symbol}
          {sec.bellwether ? <span className="bell" title="Bellwether">◆</span> : null}
          {sec.is_fund ? <span className="tag fund" title="An ETF — no income statement">ETF</span> : null}
        </div>
        <div className="dd-name">{sec.name}</div>
        <div className="dd-theme">{THEME_LABELS[sec.theme] ?? sec.theme}</div>
        {/* A name the ingest deferred is showing its last complete day, and saying so HERE as well
            as in the page banner is not redundant: the banner names a count, and a reader looking
            at one column needs to know whether THIS one is the stale one. */}
        {isBehind
          ? (
            <div className="dd-behind" title={`No bar for ${gridDate ?? "the newest date"}`}>
              older than {gridDate ?? "the newest date"}
            </div>
          )
          : null}
      </header>

      {RESOLVED.map((s) => (
        <Section
          key={s.key}
          spec={s}
          sec={sec}
          cells={cells}
          normByParam={normByParam}
          rsAsOf={rsAsOf}
          gridDate={gridDate}
        />
      ))}
    </article>
  );
}

function Section(
  { spec, sec, cells, normByParam, rsAsOf, gridDate }: {
    spec: ResolvedSection;
    sec: StripSecurity;
    cells: Record<string, CellLike>;
    normByParam: Map<string, Norm>;
    rsAsOf: string | null;
    gridDate: string | null;
  },
) {
  // WHAT THIS SECTION PUTS ON SCREEN, decided in lib/deep-dive.ts rather than here, because the CI
  // check that enumerates the strip's reachable cell states has to make the same decision and a
  // second copy of it would agree only on the day it was written. It also gets the ORDERING right:
  // "does not apply to this security" outranks "not built yet" — see that function's header for the
  // ETF panel that read as a queue position instead of a permanent fact.
  const render = sectionRender(spec, sec);

  return (
    // THE CLASS FOLLOWS WHAT THE PANEL RENDERS, not what its params' statuses are, and those two
    // are not the same question. The first version keyed off `sectionState`, so an ETF's
    // Fundamentals panel carried the heading marker "planned" above a body reading "Permanent, not
    // pending" - a temporal claim and a permanent one, contradicting each other two lines apart,
    // which a screenshot showed immediately. One concept on screen, three values, all reachable.
    <section className={`dd-sec sec-${spec.key} ss-${render}`}>
      {/* THE SUB-LINE IS HOVER TEXT, NOT BODY TEXT, and that came from looking at a screenshot.
          It describes the SECTION, so it is identical on all 22 columns here and all 53 in
          production - two lines of grey prose multiplied by the watchlist. Anything constant
          across columns is furniture in this layout; the numbers are the information. Same
          arithmetic as the 312 PLANNED tags on the Value preset. */}
      <h3 title={spec.sub}>
        {spec.title}
        {spec.key === "relative" && rsAsOf && rsAsOf !== gridDate
          ? <span className="asof">as of {rsAsOf}</span>
          : null}
        {render === "blocked" ? <span className="norm plan">planned</span> : null}
        {render === "na"
          ? <span className="tag na" title="Does not apply to this security">n&middot;a</span>
          : null}
      </h3>

      {render === "na"
        ? (
          // SHORT, for the same reason `why` is capped: this renders once per column, so the
          // reasoning goes in the page footnote and the panel gets the statement. The first
          // version ran to 186 characters and printed ten times across five ETF columns.
          <p className="dd-why na">
            Not applicable to {sec.symbol} —{" "}
            {sec.is_fund ? "an ETF has no income statement" : "its theme is not a peer group"}.
            Permanent, not pending.
          </p>
        )
        : render === "blocked"
        // The `why` is REQUIRED on a planned section that renders params and decides the state of
        // one that renders a series — lib/deep-dive.ts throws at load if it is missing or stale.
        // So this branch always has a sentence, and it is always the current one.
        ? <p className="dd-why">{spec.why}</p>
        : (
          <>
            {/* The price panel. Its own component because it is the only section that fetches:
                the bars are far too many to travel in the page payload, so they arrive per column
                when you scroll to one. Decision 0049. */}
            {spec.kind === "chart" ? <StockChart symbol={sec.symbol} /> : null}
            {spec.kind === "gauges"
              ? (
                <Gauges
                  spec={spec}
                  sec={sec}
                  cells={cells}
                  normByParam={normByParam}
                />
              )
              : null}
            {spec.kind === "rows"
              ? <Rows spec={spec} sec={sec} cells={cells} normByParam={normByParam} />
              : null}
            {spec.kind === "bars"
              ? <Bars spec={spec} sec={sec} cells={cells} />
              : null}
            {/* There was a branch here for "a live section with an unbuilt param in it, other than
                the gauges". It could not run: the only live section carrying a planned param is
                RSI, and RSI is a gauges section, so the condition excluded the only case that
                satisfies it. Measured, not reasoned - the rendered page had no such element on any
                of 22 columns. An unbuilt param inside a live section shows as a dash with the
                reason on hover, which is what the gauges do. */}
          </>
        )}
    </section>
  );
}

/**
 * The three RSI gauges: hourly, daily, weekly.
 *
 * Bars on a 0-100 track rather than dials, and that is a considered choice rather than a shortcut.
 * RSI is bounded by construction, so a track shows the whole domain honestly; the norm band is a
 * rectangle whose edges land exactly on the thresholds, which an arc only approximates. A dial
 * would need trig to place the same two edges and would read as a speedometer — a device whose
 * whole vocabulary is "more is faster", which is not what 30 and 70 mean.
 *
 * THE BAND COMES FROM THE NORM, never from a literal 30/70. `rsi_weekly` is 40/70 in
 * `config/norms.yml` today while the other two are 30/70, so a hardcoded band would have drawn the
 * weekly threshold ten points from where the colouring actually changes.
 */
function Gauges(
  { spec, sec, cells, normByParam }: {
    spec: ResolvedSection;
    sec: StripSecurity;
    cells: Record<string, CellLike>;
    normByParam: Map<string, Norm>;
  },
) {
  return (
    <div className="dd-gauges">
      {spec.columns.map((c) => {
        const cell = cells[`${sec.symbol}|${c.param}`];
        const st = cellState(c, sec, cell);
        const norm = normByParam.get(c.param);
        const g = gaugeGeometry(st === "planned" || st === "null" ? null : cell?.value, norm);
        return (
          <div key={c.param} className={`dd-gauge st-${st}`}>
            <span className="g-tf">{TIMEFRAME_LABELS[c.timeframe] || "—"}</span>
            <span className="g-track">
              {g.band
                ? (
                  <span
                    className="g-band"
                    style={{ left: `${g.band.left}%`, width: `${g.band.width}%` }}
                  />
                )
                : null}
              {g.value !== null
                ? (
                  <span
                    className={COLOURED.has(st) ? `g-mark mark st-${st}` : "g-mark"}
                    style={{ left: `${g.value}%` }}
                  />
                )
                : null}
            </span>
            <span className="g-val">
              {st === "planned"
                ? (
                  <span
                    className="dash"
                    title="The norm is set and the number is not computed: hourly bars are not session-aligned yet, and RSI read against 30/70 moves with the alignment."
                  >
                    —
                  </span>
                )
                : st === "null"
                ? <span className="dash">—</span>
                : (
                  <>
                    {formatValue(cell?.value, c.digits, c.signed)}
                    {st === "warmup" ? <span className="warm" title="Inside its warm-up window — shown, never judged">*</span> : null}
                  </>
                )}
            </span>
            <span className="g-norm">{norm ? formatNorm(norm) : "no norm"}</span>
          </div>
        );
      })}
      {/* NO EXPLANATORY LINE HERE, and there was one. "The H gauge has its norm set and no number:
          hourly bars are not session-aligned yet..." is a fact about the PARAMETER, identical on
          every column, so it printed three lines of prose 22 times across the strip. It is now said
          once, in the page footnote under the strip, and the H gauge's own dash carries it as hover
          text. Same correction as the sub-lines, from the same screenshot. */}
    </div>
  );
}

/** Label / value rows. The same rendering conventions as a grid cell, in a vertical panel. */
function Rows(
  { spec, sec, cells, normByParam }: {
    spec: ResolvedSection;
    sec: StripSecurity;
    cells: Record<string, CellLike>;
    normByParam: Map<string, Norm>;
  },
) {
  return (
    <dl className="dd-rows">
      {spec.columns.map((c) => {
        const cell = cells[`${sec.symbol}|${c.param}`];
        const st = cellState(c, sec, cell);
        const norm = normByParam.get(c.param);
        const tf = TIMEFRAME_LABELS[c.timeframe];
        return (
          <div key={c.param} className={`dd-row st-${st}${COLOURED.has(st) ? " mark" : ""}`}>
            <dt>
              {c.label}
              {tf ? <span className="tf">{tf}</span> : null}
              {norm ? <span className="norm">{formatNorm(norm)}</span> : null}
            </dt>
            <dd><Payload col={c} cell={cell} state={st} /></dd>
          </div>
        );
      })}
    </dl>
  );
}

/**
 * Signed magnitude against a zero line.
 *
 * The number beside the bar is always the real value; the bar clips at ±RS_BAR_LIMIT and says so
 * when it does. A scale that stretched to fit the largest 252-bar reading in this watchlist would
 * squash every ordinary name into a couple of pixels — the bar is the glance, the number is the
 * fact, and the two must not be allowed to disagree silently.
 */
function Bars(
  { spec, sec, cells }: {
    spec: ResolvedSection;
    sec: StripSecurity;
    cells: Record<string, CellLike>;
  },
) {
  return (
    <div className="dd-bars">
      {spec.columns.map((c) => {
        const cell = cells[`${sec.symbol}|${c.param}`];
        const st = cellState(c, sec, cell);
        const g = st === "planned" || st === "null" ? null : barGeometry(cell?.value);
        return (
          <div key={c.param} className={`dd-bar st-${st}`}>
            <span className="b-lab">{c.label.replace("vs SPX ", "")}</span>
            <span className="b-track">
              <span className="b-zero" aria-hidden="true" />
              {g
                ? (
                  <span
                    className={`b-fill ${g.side}${g.clipped ? " clipped" : ""}`}
                    style={{ width: `${g.width / 2}%` }}
                    title={g.clipped ? `Past ±${RS_BAR_LIMIT}pp — the bar is at its limit, the number is exact` : undefined}
                  />
                )
                : null}
            </span>
            <span className="b-val">
              <Payload col={c} cell={cell} state={st} />
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * A value, rendered by its state.
 *
 * Shared by the row and bar panels so the two cannot disagree about what a warm-up asterisk or an
 * `n·a` looks like. Same conventions as a grid cell: `planned` and `null` are both a dash, because
 * the distinction is carried by the section heading and by the sentence under it, not by the glyph.
 */
function Payload(
  { col, cell, state }: { col: Column; cell: CellLike | undefined; state: CellState },
) {
  // NO `na` BRANCH, and that is checked rather than assumed. A section whose every param is
  // inapplicable collapses to a single sentence before reaching here (sectionRender), and every
  // param carrying an `applies` predicate today lives in one of those two sections - so no strip
  // cell can be in that state. check_strip_sections.sh enumerates the states the strip can produce
  // and fails if one has no rule; the day a section mixes applicable params with inapplicable ones,
  // it will ask for this branch and its CSS back, together.
  if (state === "planned") {
    return <span className="dash" title="Designed and not built — see the note under the heading">—</span>;
  }
  if (state === "null") return <span className="dash">—</span>;
  if (col.render === "chip") {
    return (
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
  }
  if (col.render === "sparkline") return <span className="dash">—</span>;
  return (
    <>
      {formatValue(cell?.value, col.digits, col.signed)}
      {col.suffix ? <span className="unit">{col.suffix}</span> : null}
      {state === "warmup"
        ? <span className="warm" title="Inside its warm-up window — shown, never judged">*</span>
        : null}
    </>
  );
}
