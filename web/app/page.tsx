/**
 * The Dashboard tab: market context above, the parameter grid below.
 *
 * A SERVER COMPONENT THAT HANDS ROWS TO A CLIENT ONE. It reads the database with the service_role
 * key, merges the three cell views into one lookup, and passes plain data to `ParameterGrid`,
 * which runs in the browser so presets, sorting and filtering feel instant.
 *
 * The key never crosses: `lib/grid.ts` is imported HERE and nowhere a client component can reach.
 * `scripts/ci/check_web_boundary.sh` enforces that rather than leaving it to this comment.
 *
 * WHAT THIS PAGE MUST NOT DO, restated because the grid got much denser and the temptations grow:
 *   - It must not hide staleness. One scheduled ingest a day, no refresh button for anyone.
 *   - It must not colour a value that has no norm. Grey means "we have no opinion", which is a
 *     different statement from "inside the band".
 *   - It must not colour a value inside its warm-up window, even though the number exists.
 *   - It must not let a column that was not READ look like a column with no DATA.
 */
import MarketHistory from "../components/MarketHistory";
import ParameterGrid, { type GridRow } from "../components/ParameterGrid";
import type { CellLike } from "../lib/columns";
import { MARKET_TILES } from "../lib/market";
import { formatValue } from "../lib/columns";
import {
  fetchGrid,
  REVALIDATE_SECONDS,
  type MarketCell,
  type Status,
} from "../lib/grid";

// One upstream read serves every viewer for this long. Must be a literal: Next statically analyses
// segment config and rejects an imported constant. The line below is the guard against the two
// copies drifting - it is a type assertion, compiles to nothing, and fails the build if they differ.
export const revalidate = 900;
const _revalidateIsInSync: typeof revalidate = REVALIDATE_SECONDS;
void _revalidateIsInSync;

/**
 * UNDEFINED IS NOT NULL, AND NEITHER OF THEM IS "OK".
 *
 * `undefined` means the field was not in the response - a page rendered against an older schema,
 * as on 2026-09-13, where the render read that as "never" and displayed a cheerful "never · ok"
 * while the pipeline was perfectly healthy. An absent field is not evidence of freshness.
 */
function freshnessUnknown(status: Status | null): boolean {
  return !!status && (status.hours_since_success === undefined || status.is_stale === undefined);
}

/**
 * "Monday evening" — a scheduled run named the way a person would say it.
 *
 * Deliberately not the full timestamp. The banner is read by someone deciding whether to worry,
 * and "the ingest scheduled for Monday evening did not complete" answers that; the exact instant
 * is on /status for whoever is actually debugging it. Falls back to the raw value rather than
 * guessing if the string is not a date we can parse — an unreadable timestamp in a banner about
 * reliability should look wrong, not plausible.
 */
function fmtRun(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = d.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
  const h = d.getUTCHours();
  const part = h < 5 ? "night" : h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
  return `${day} ${part}`;
}

function freshness(status: Status | null): string {
  if (!status) return "unknown";
  if (freshnessUnknown(status)) return "unknown";
  const age = typeof status.hours_since_success === "number"
    ? `${Math.round(status.hours_since_success)}h ago`
    : "never";
  return `${age}${status.is_stale ? " · stale" : " · ok"}`;
}

/**
 * "42 of 53 priced today" — or null when the question cannot be answered.
 *
 * Returns null for `undefined` (a deployment older than migration 20260918060000, which knows
 * nothing about per-symbol coverage) and for a count that is not behind. It does NOT return null
 * for zero: zero behind is an answer, and it is the one the reader wants most.
 */
function partialDay(status: Status | null): { priced: number; tracked: number; behind: number } | null {
  if (!status) return null;
  const priced = status.symbols_priced;
  const tracked = status.symbols;
  const behind = status.symbols_behind;
  if (typeof priced !== "number" || typeof tracked !== "number" || typeof behind !== "number") {
    return null;
  }
  return { priced, tracked, behind };
}

function MarketBlock(
  { market, gridDate, error }: {
    market: MarketCell[];
    gridDate: string | null;
    error: string | null;
  },
) {
  if (error) {
    return (
      <div className="market">
        <div className="market-err">
          <b>The market block could not be read.</b> The grid below is unaffected and current.{" "}
          <span className="err">{error}</span>
        </div>
      </div>
    );
  }
  if (market.length === 0) return null;
  const by = new Map<string, MarketCell>();
  for (const m of market) if (m.param) by.set(m.param, m);

  return (
    <div className="market">
      {MARKET_TILES.map((t) => {
        const c = by.get(t.param);
        const v = c?.verdict ?? null;
        // The verdict names a DIRECTION; the tile's scale decides what that direction is called in
        // colour. On the verdict scale below/above are the red/green pair every security metric
        // uses; on the intensity scale they are calm/stressed, which is VIX and nothing else today.
        // See the note above MARKET_TILES for why VIX is not simply inverted.
        const tone = v === "below" || v === "above"
          ? (t.scale === "intensity" ? (v === "below" ? "calm" : "stress") : v)
          : null;
        const cls = tone ? `tile mark ${tone}` : "tile";
        const asOf = c?.as_of ?? null;
        return (
          <div key={t.param} className={cls} title={t.hint}>
            <span className="tile-k">{t.label}</span>
            <span className="tile-v">
              {formatValue(c?.value ?? null, t.digits, t.signed)}
              {c?.value === null || c?.value === undefined ? "" : t.suffix}
            </span>
            {/* WHAT THIS NUMBER IS, IN WORDS, on its own reserved line. The states triple names
                the side of the norm this value fell on, so the tile is readable without decoding
                the colour — which is what makes it survive greyscale, and what the spec asks for.
                Reserved even when empty, for the same reason .tile-d is: these four tiles are a
                row, and a line that appears on one of them makes that tile taller than the rest.
                Kept separate from the date line rather than sharing one, because at 10px the two
                together wrap at the narrow end of the tile grid, and wrapping is the height. */}
            <span className="tile-s">
              {t.states && (v === "below" || v === "normal" || v === "above")
                ? t.states[v]
                : t.note ?? "\u00a0"}
            </span>
            <span className="tile-d">
              {asOf && asOf !== gridDate ? `as of ${asOf}` : c?.has_norm === false ? "no norm" : " "}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default async function Dashboard() {
  const {
    status, tickers, cells, norms, market, rs, signals, rsAsOf,
    history, historyError,
    marketError, rsError, signalsError, error,
  } = await fetchGrid();

  if (error) {
    return (
      <main className="wide">
        <h1>Swing Tracker</h1>
        <div className="panel">
          <h2>The grid could not be loaded</h2>
          <p className="err">{error}</p>
          <p className="muted">
            Nothing is cached from a previous good load, deliberately — a stale grid shown without
            saying so is the failure this page exists to avoid. <a href="/status">Deployment check</a>
          </p>
        </div>
      </main>
    );
  }

  // ONE LOOKUP, THREE SOURCES. The views are separate because they are keyed on different dates
  // and computed differently; the reader does not care, so they are merged here rather than in the
  // component. Param names are globally unique, so the merge cannot collide - and if one ever did,
  // the CI check that no norm key reaches signal_cells would be the thing that caught it.
  const byCell: Record<string, CellLike> = {};
  for (const c of cells) byCell[`${c.symbol}|${c.param}`] = c;
  for (const c of rs) byCell[`${c.symbol}|${c.param}`] = c;
  for (const s of signals) {
    if (s.symbol && s.param) {
      byCell[`${s.symbol}|${s.param}`] = {
        value: s.value,
        label: s.label,
        tone: s.tone,
        suppressed_warmup: s.seed_ok === false,
      };
    }
  }

  const rows: GridRow[] = tickers.map((t) => ({
    symbol: t.symbol,
    name: t.name,
    theme: t.theme,
    bellwether: t.bellwether,
    is_fund: t.is_fund,
    rankable: t.rankable,
  }));

  const partial = partialDay(status);

  // Named blocks, not a boolean. "Relative strength could not be read" and "the signals could not
  // be read" are different sentences, and a reader deciding whether to trust a column needs to
  // know which one is missing.
  const unavailable = [
    rsError ? "Relative strength" : null,
    signalsError ? "MA signals" : null,
  ].filter((x): x is string => x !== null);

  return (
    <main className="wide">
      <header className="head">
        <div>
          <h1>Parameter grid</h1>
          <p className="sub">
            {rows.length} securities grouped by theme. The same parameters on every name — colour
            marks a value outside a norm we set. No score, no ranking.
          </p>
        </div>
        <div className="status">
          <div className="stat">
            <span className="stat-k">Data through</span>
            <span className="stat-v">{status?.data_through ?? "—"}</span>
          </div>
          <div className="stat">
            <span className="stat-k">Names</span>
            <span className="stat-v">{rows.length}</span>
          </div>
          {/* Only when it differs. A "priced today" stat that always reads the same as Names is
              furniture; one that appears when it diverges is information. */}
          {partial && partial.behind > 0
            ? (
              <div className="stat">
                <span className="stat-k">Priced today</span>
                <span className="stat-v warnv">{partial.priced}</span>
              </div>
            )
            : null}
          <div className="stat">
            <span className="stat-k">Last ingest</span>
            <span className="stat-v">{freshness(status)}</span>
          </div>
        </div>
      </header>

      {/* Order matters: "we could not read freshness" outranks "the data is stale", because the
          second is a verdict and the first says no verdict is available. */}
      {freshnessUnknown(status)
        ? (
          <div className="banner stale">
            <b>Freshness could not be read.</b> The page loaded, but the status view did not return
            the fields that say when the pipeline last succeeded. The numbers below may be current
            or may not be; this page cannot tell you which, and it will not guess.
          </div>
        )
        : status?.is_stale
        ? (
          <div className="banner stale">
            {/* NAMES THE RUN THAT WAS MISSED, not the hours elapsed.
                Until 2026-09-20 this said "last completed N hours ago… it should run every weekday
                evening" — and on a Sunday it said that about a Friday run that had completed
                perfectly, because the rule was a flat 30-hour count on a pipeline that does not
                run at weekends (decision 0056). It was wrong for 42 of every 168 hours.
                Now `is_stale` is schedule-aware, so reaching this branch means a scheduled run
                genuinely did not complete, and the useful sentence says WHICH one. The hour count
                stays as the secondary fact; it was never the actionable part. */}
            <b>
              {status.last_success_at === null || status.last_success_at === undefined
                ? "The daily ingest has never completed successfully."
                : status.last_expected_at
                ? `The ingest scheduled for ${fmtRun(status.last_expected_at)} did not complete.`
                : "A scheduled ingest did not complete."}
            </b>{" "}
            The schedule is the only way data moves — there is no refresh button. The numbers below
            are real; they are just not as current as they should be. Newest bar:{" "}
            {status.data_through ?? "none"}
            {typeof status.hours_since_success === "number"
              ? `, last successful run ${Math.round(status.hours_since_success)}h ago.`
              : "."}
          </div>
        )
        : null}

      {/* ADDITIVE, not another branch of the chain above. "The pipeline is stale" and "today's run
          covered 42 of 53 names" are different failures and can be true at once; folding this into
          the same if/else would let one hide the other. */}
      {partial && partial.behind > 0
        ? (
          <div className="banner stale">
            <b>
              {partial.priced} of {partial.tracked} names have a bar for{" "}
              {status?.data_through ?? "the newest date"}.
            </b>{" "}
            The other {partial.behind} were deferred by the ingest and are showing their last
            complete day, which is why their price and RSI cells are blank rather than coloured.
            The numbers on them are not wrong; they are older than the rest of this page. A run
            reports success even when it defers, so this line is the only place that says so.
          </div>
        )
        : null}

      <MarketBlock
        market={market}
        gridDate={status?.data_through ?? null}
        error={marketError}
      />

      {/* Under the tiles, above the grid, and SHUT until asked for. The grid is the product; four
          charts of once-a-day context would push 53 rows below the fold on every load to say
          something the four tiles already summarise. */}
      <MarketHistory
        rows={history}
        error={historyError}
        gridDate={status?.data_through ?? null}
      />

      <ParameterGrid
        rows={rows}
        cells={byCell}
        norms={norms}
        rsAsOf={rsAsOf}
        gridDate={status?.data_through ?? null}
        unavailable={unavailable}
      />

      <p className="note">
        “Off 5y high” is measured against the highest price we <em>hold</em>, not an all-time high —
        the data plan carries five years, and several names on this list peaked in 2000. A column
        whose heading reads <span className="planword">planned</span> is a parameter that is
        designed and not yet built — its cells are dashes because nobody has that number, not
        because this name is missing it. <span className="tag na">n·a</span> in a cell means the
        question does not apply to that security, which is a third thing again.
        {status?.last_run_at
          ? (
            <>
              {" "}Most recent run of any kind:{" "}
              {new Date(status.last_run_at).toISOString().slice(0, 16).replace("T", " ")} UTC
              {status.last_run_by ? ` (${status.last_run_by})` : ""}
              {status.last_run_ok === false ? ", which reported a problem" : ""}.
            </>
          )
          : null}
      </p>
    </main>
  );
}
