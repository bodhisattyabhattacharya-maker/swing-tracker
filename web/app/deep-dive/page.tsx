/**
 * The Deep Dive tab: one analysis column per stock, side by side.
 *
 * A SERVER COMPONENT THAT HANDS ROWS TO A CLIENT ONE, the same shape as the Dashboard. It reads the
 * database with the service_role key and passes plain data to `StockStrip`, which runs in the
 * browser so the filter and the scroll scrim feel instant. The key never crosses: `lib/grid.ts` is
 * imported HERE and nowhere a client component can reach, and
 * `scripts/ci/check_web_boundary.sh` enforces that rather than leaving it to this comment.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS CALLS `fetchGrid` RATHER THAN A READ OF ITS OWN
 *
 * This page needs the same rows the Dashboard needs — tickers, cells, RS, signals, norms — so a
 * second fetch path would be a second place for the merge and the as-of handling to drift, and the
 * as-of handling is the part this project has already got wrong twice.
 *
 * It costs no extra upstream reads. Next's Data Cache is keyed on the request URL and shared across
 * routes in a deployment, and every read in `fetchGrid` goes out with `next: { revalidate: 900 }`,
 * so whichever of the two pages is visited first populates the cache and the other is served from
 * it. `fetchGrid` also pulls the market tiles and the market history, which this page does not
 * render — those are two cached reads this page does not use, not two extra round trips to Supabase.
 * Worth saying plainly rather than calling it free.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PAGE MUST NOT DO
 *
 *   - It must not order the strip by any parameter. No score, no ranking (hard constraint 1).
 *   - It must not collapse the strip into a vertical stack at any width.
 *   - It must not let a section that was not READ look like a section with no DATA.
 *   - It must not show an empty frame for a section that is not built. Every such section says
 *     which of three things is blocking it, in words.
 */
import StockStrip from "../../components/StockStrip";
import { type CellLike, TIMEFRAME_LABELS } from "../../lib/columns";
import { plannedWithin, RESOLVED, sectionState, type StripSecurity } from "../../lib/deep-dive";
import { fetchGrid, REVALIDATE_SECONDS } from "../../lib/grid";

// Must be a literal: Next statically analyses segment config and rejects an imported constant. The
// line below is the guard against the two copies drifting — it is a type assertion, compiles to
// nothing, and fails the build if they differ.
export const revalidate = 900;
const _revalidateIsInSync: typeof revalidate = REVALIDATE_SECONDS;
void _revalidateIsInSync;

/**
 * "hourly RSI 14" — the timeframe spelled out for prose.
 *
 * `TIMEFRAME_LABELS` gives "H", which is right inside a 420px panel and wrong in a sentence. Keyed
 * on the same union so a new timeframe cannot be added without this being a type error.
 */
const TIMEFRAME_WORDS: Record<keyof typeof TIMEFRAME_LABELS, string> = {
  hourly: "hourly",
  daily: "daily",
  weekly: "weekly",
  none: "",
};

export default async function DeepDive() {
  const {
    status, tickers, cells, norms, rs, signals, rsAsOf, rsError, signalsError, error,
  } = await fetchGrid();

  if (error) {
    return (
      <main className="wide">
        <h1>Deep Dive</h1>
        <div className="panel">
          <h2>The data could not be loaded</h2>
          <p className="err">{error}</p>
          <p className="muted">
            Nothing is cached from a previous good load, deliberately — a stale page shown without
            saying so is the failure this product exists to avoid.{" "}
            <a href="/status">Deployment check</a>
          </p>
        </div>
      </main>
    );
  }

  // ONE LOOKUP, THREE SOURCES — identical to the Dashboard's merge, because it is the same three
  // views keyed on the same two things. Param names are globally unique, so the merge cannot
  // collide.
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

  const rows: StripSecurity[] = tickers.map((t) => ({
    symbol: t.symbol,
    name: t.name,
    theme: t.theme,
    bellwether: t.bellwether,
    is_fund: t.is_fund,
    rankable: t.rankable,
  }));

  /**
   * WHICH names are a day behind, derived rather than asked for.
   *
   * `grid_status` publishes `symbols_behind` as a COUNT; the strip needs the LIST, because a reader
   * looking at one column has to know whether that column is the stale one. A deferred symbol has
   * no row in `grid_cells` on `data_through`, so it has no `close` cell — the list is already in
   * the data this page fetched, and asking for it separately would be a fourth read to learn
   * something that is sitting in the second one.
   */
  const behind = rows.filter((r) => !byCell[`${r.symbol}|close`]).map((r) => r.symbol);

  /**
   * The count from the view against the list derived here.
   *
   * A generic cross-check, and it is here because of a specific habit: on 2026-09-17 a claim about
   * `breadth_tracked` was reasoned from a definition rather than measured, was wrong by eleven, and
   * hid a real ingest defect for a day. Two numbers that should agree, both already in hand, cost
   * nothing to compare — and if they ever disagree, the honest move is to show both rather than
   * pick the one that suits the layout.
   */
  const claimed = typeof status?.symbols_behind === "number" ? status.symbols_behind : null;
  const disagrees = claimed !== null && claimed !== behind.length;

  /**
   * Params that are inside a section which renders data, and are still not built.
   *
   * DERIVED, so the footnote sentence about them cannot go stale. The hourly RSI gauge is the only
   * one today. When session-aligned hourly bars land in Phase 5, `rsi_hourly` flips to `live` in
   * `lib/columns.ts` and this list empties, which removes the sentence — rather than leaving a
   * paragraph on the page explaining a limitation that no longer exists. Hand-written prose about
   * the state of the data is the thing that rots; this project has now been bitten by a
   * hand-maintained list three times.
   */
  const unbuilt = RESOLVED
    .filter((s) => sectionState(s) === "live")
    .flatMap((s) => plannedWithin(s))
    .map((c) => `${TIMEFRAME_WORDS[c.timeframe]} ${c.label}`.trim());

  const unavailable = [
    rsError ? "Relative strength" : null,
    signalsError ? "MA signals" : null,
  ].filter((x): x is string => x !== null);

  return (
    <main className="wide">
      <header className="head">
        <div>
          <h1>Deep Dive</h1>
          <p className="sub">
            One analysis column per stock, {rows.length} of them, side by side. The same sections at
            the same heights on every name — scroll sideways to compare one thing across the
            watchlist. No score, no ranking.
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
          {behind.length > 0
            ? (
              <div className="stat">
                <span className="stat-k">A day behind</span>
                <span className="stat-v warnv">{behind.length}</span>
              </div>
            )
            : null}
        </div>
      </header>

      {behind.length > 0
        ? (
          <div className="banner stale">
            <b>
              {behind.length} {behind.length === 1 ? "name has" : "names have"} no bar for{" "}
              {status?.data_through ?? "the newest date"}.
            </b>{" "}
            Each is marked in its own column heading and is showing its last complete day. The
            numbers on them are not wrong; they are older than the rest of this page.
            {disagrees
              ? (
                <>
                  {" "}The status view reports {claimed} behind and this page finds{" "}
                  {behind.length} without a close on that date. Both are printed because they
                  disagree, and the disagreement is the finding.
                </>
              )
              : null}
          </div>
        )
        : null}

      <StockStrip
        rows={rows}
        cells={byCell}
        norms={norms}
        gridDate={status?.data_through ?? null}
        rsAsOf={rsAsOf}
        unavailable={unavailable}
        behind={behind}
      />

      {/* EVERYTHING CONSTANT ACROSS COLUMNS IS SAID HERE, ONCE.
          The strip renders one panel per section per security, so any sentence inside a panel is
          printed once per name — 22 times against this fixture, 53 in production. That arithmetic
          is what turned a per-cell PLANNED tag into 312 of them on the Value preset (Bodhi,
          2026-09-18: "header only is fine"). So the panels carry a statement and this note carries
          the reasoning. */}
      <p className="note">
        <b>The price panel reads its bars when you scroll to it</b>, not when the page loads: 53
        names at about 1,260 daily bars each is far more than a page payload can carry, so each
        column asks for its own series and a column you never reach costs nothing. It opens on a
        quarter, draws candles while each one has room to be a candle, becomes a line once they do
        not, and can be dragged back through everything stored. The weekly view shows{" "}
        <em>completed weeks only</em> — the week in progress is excluded, because the averages
        drawn over it are computed on completed weeks and a candle ahead of its own overlays is
        worse than a chart that is a week short.
        {" "}Two of the eight sections are still not built, for two different reasons.{" "}
        <b>Fundamentals</b> waits on the financials ingest, and that waits on the vendor add-on and
        its four acceptance probes: nobody has those numbers here yet, for any name. <b>Forward
        Look</b> has no source at any vendor tier, so it will arrive as searched values carrying
        their own source and as-of date rather than as measurements — that is permanent, not a
        queue position. Neither is a loading state, and a panel that is blank says which it is.
        {unbuilt.length > 0
          ? (
            <>
              {" "}Inside the sections that <em>are</em> built, {unbuilt.join(" and ")} has its norm
              set and no number: hourly bars are not session-aligned yet, and RSI read against 30/70
              moves with the alignment. Its gauge keeps the band and loses the marker.
            </>
          )
          : null}
        {" "}A panel marked <em>not applicable</em> is a third thing again, and the strongest
        statement on the page: an ETF has no income statement and an unrankable theme has no peer
        group, so those panels are not waiting for anything and will not fill in when Phase 4
        lands. Section headings carry their one-line definition as hover text; the full definition
        of any parameter is in the Dashboard&rsquo;s cell detail sheet.
      </p>
    </main>
  );
}
