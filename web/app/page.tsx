/**
 * The dashboard. One row per active non-index ticker, banded by theme, with every parameter that
 * exists today and a verdict on the four that currently have a norm.
 *
 * Server component. It reads the database on the server and ships HTML; the browser never talks to
 * Postgres and never sees a key. See lib/grid.ts for why.
 *
 * WHAT THIS PAGE MUST NOT DO, and the reason it is stated here rather than assumed:
 *   - It must not hide staleness. v1 runs one scheduled ingest a day, has no retry, and has no
 *     refresh button for anyone. So the realistic failure is ten people reading numbers that look
 *     current and are not. The freshness line is always rendered and the banner is not dismissible.
 *   - It must not colour a value that has no norm. A grey number means "we have no opinion",
 *     which is a different statement from "inside the norm", and the two must not look alike.
 *   - It must not colour a value still inside its warm-up window, even though the number exists.
 *     `suppressed_warmup` marks those; hard constraint 8.
 */
import {
  COLUMNS,
  columnGroups,
  fetchGrid,
  formatNorm,
  formatValue,
  REVALIDATE_SECONDS,
  THEME_LABELS,
  type Cell,
  type Norm,
  type Status,
} from "../lib/grid";

// One upstream read serves every viewer for this long. The data changes once a day, so this is
// about bounding staleness, not about load - ten readers would not trouble the database anyway.
//
// This MUST be a literal. Next statically analyses segment config exports and rejects an imported
// constant ("Invalid segment configuration export"), so the number appears here and in lib/grid.ts.
// The line below is the guard against those two drifting: it is a type assertion, compiles to
// nothing, and fails the build if they ever disagree.
export const revalidate = 900;
const _revalidateIsInSync: typeof revalidate = REVALIDATE_SECONDS;
void _revalidateIsInSync;

/**
 * UNDEFINED IS NOT NULL, AND NEITHER OF THEM IS "OK".
 *
 * Three different things used to render as the same cheerful "never · ok":
 *   null       the pipeline genuinely has never completed - a fact the view is reporting.
 *   undefined  the FIELD WAS NOT THERE. The view this build renders against does not have it,
 *              which on 2026-09-13 meant a page prerendered before its migration applied, showing
 *              "never · ok" while the pipeline was perfectly healthy (INCIDENTS.md).
 *   a number   the real age.
 *
 * The third of those is the only one that supports a verdict. `is_stale` being undefined is not
 * evidence of freshness, so it must not print "ok" - the same mistake, in the same week, that made
 * the digest treat an unread change list as a quiet day.
 */
function freshnessUnknown(status: Status | null): boolean {
  return !!status && (status.hours_since_success === undefined || status.is_stale === undefined);
}

function freshness(status: Status | null): string {
  if (!status) return "unknown";
  if (freshnessUnknown(status)) return "unknown";
  const age = typeof status.hours_since_success === "number"
    ? `${Math.round(status.hours_since_success)}h ago`
    : "never";
  return `${age}${status.is_stale ? " · stale" : " · ok"}`;
}

/** The first column whose timeframe differs from the one before it — where the divider goes. */
const groupStart =
  COLUMNS.find((c, i) => i > 0 && c.timeframe !== COLUMNS[i - 1].timeframe)?.param ?? null;

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="panel">
      <h2>{title}</h2>
      {children}
    </div>
  );
}

export default async function Grid() {
  const { status, tickers, cells, norms, error } = await fetchGrid();

  if (error) {
    return (
      <main>
        <h1>Swing Tracker</h1>
        <Panel title="The grid could not be loaded">
          <p className="err">{error}</p>
          <p className="muted">
            Nothing is cached from a previous good load, deliberately — a stale grid shown without
            saying so is the failure this page exists to avoid. <a href="/status">Deployment check</a>
          </p>
        </Panel>
      </main>
    );
  }

  // Pivot: one lookup per (symbol, param). Doing this here rather than in SQL keeps the view long
  // and generic - adding a parameter is one line in COLUMNS and one in the view's unpivot.
  const by = new Map<string, Cell>();
  for (const c of cells) by.set(`${c.symbol}|${c.param}`, c);
  const normByParam = new Map<string, Norm>(norms.map((n) => [n.param, n]));

  let lastTheme: string | null = null;
  const perTheme = new Map<string, number>();
  for (const t of tickers) perTheme.set(t.theme, (perTheme.get(t.theme) ?? 0) + 1);

  const judged = COLUMNS.filter((c) => normByParam.has(c.param)).length;

  return (
    <main className="wide">
      <header className="head">
        <div>
          <h1>Swing Tracker</h1>
          <p className="sub">
            The same parameters on every name we hold a thesis on. Colour marks a value outside a
            norm we set — there is no score and no ranking here.
          </p>
        </div>
        <div className="status">
          <div className="stat">
            <span className="stat-k">Data through</span>
            <span className="stat-v">{status?.data_through ?? "—"}</span>
          </div>
          <div className="stat">
            <span className="stat-k">Names</span>
            <span className="stat-v">{tickers.length}</span>
          </div>
          <div className="stat">
            <span className="stat-k">Last ingest</span>
            <span className="stat-v">{freshness(status)}</span>
          </div>
        </div>
      </header>

      {/* Order matters: "we could not read freshness" outranks "the data is stale", because the
          second is a verdict and the first says no verdict is available. Testing stale first would
          let an undefined is_stale fall through to the quiet no-banner branch. */}
      {freshnessUnknown(status) ? (
        <div className="banner stale">
          <b>Freshness could not be read.</b> The page loaded, but the status view did not return
          the fields that say when the pipeline last succeeded — most likely this build was rendered
          against an older schema, as on 2026-09-13. The numbers below may be current or may not be;
          this page cannot tell you which, and it will not guess. Corrects itself on the next
          revalidation.
        </div>
      ) : status?.is_stale ? (
        <div className="banner stale">
          <b>
            {typeof status.hours_since_success === "number"
              ? `The daily ingest last completed ${Math.round(status.hours_since_success)} hours ago.`
              : "The daily ingest has never completed successfully."}
          </b>{" "}
          It should run every weekday evening, and the schedule is the only way data moves — there
          is no refresh button. The numbers below are real; they are just not as current as they
          should be. Newest bar: {status.data_through ?? "none"}.
        </div>
      ) : null}

      <div className="scroll">
        <table>
          {/* The rule down the left of the weekly block is drawn from the data, not typed in:
              whichever column first changes timeframe gets it. Reorder COLUMNS and it follows. */}
          <thead>
            {/* Two rows, because "vs 21 EMA" is a different number on daily bars than on weekly
                ones and the label alone does not say which. The weekly group names the week it is
                as of, so a reader is not left wondering why those columns sat still all week. */}
            <tr className="grp">
              <th className="sym" />
              {columnGroups().map((g, i) => (
                <th key={`${g.timeframe}-${i}`} colSpan={g.span} className={g.timeframe}>
                  {g.label}
                </th>
              ))}
            </tr>
            <tr>
              <th className="sym">Symbol</th>
              {COLUMNS.map((c) => {
                const n = normByParam.get(c.param);
                return (
                  <th
                    key={c.param}
                    className={c.param === groupStart ? `${c.timeframe} grp-start` : c.timeframe}
                  >
                    {c.label}
                    {n ? <span className="norm">{formatNorm(n)}</span> : null}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {tickers.map((t) => {
              const band =
                t.theme !== lastTheme ? ((lastTheme = t.theme), t.theme) : null;
              return (
                <>
                  {band ? (
                    <tr className="band" key={`band-${band}`}>
                      <td colSpan={COLUMNS.length + 1}>
                        {THEME_LABELS[band] ?? band}
                        <span className="n">{perTheme.get(band)} names</span>
                      </td>
                    </tr>
                  ) : null}
                  <tr key={t.symbol}>
                    <td className="sym">
                      {t.symbol}
                      {t.bellwether ? (
                        <span className="bell" title="Bellwether">
                          ◆
                        </span>
                      ) : null}
                      <span className="co">{t.name}</span>
                    </td>
                    {COLUMNS.map((c) => {
                      const cell = by.get(`${t.symbol}|${c.param}`);
                      const v = cell?.verdict ?? null;
                      const cls =
                        v === "below" || v === "above" ? `mark ${v}` : "unjudged";
                      return (
                        <td
                          key={c.param}
                          className={c.param === groupStart ? `${cls} grp-start` : cls}
                        >
                          {formatValue(cell?.value ?? null, c.digits, c.signed)}
                          {cell?.suppressed_warmup ? <span className="warm" title="Inside its warm-up window — shown, never judged">*</span> : null}
                        </td>
                      );
                    })}
                  </tr>
                </>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="foot">
        <div>
          <h2>Reading a cell</h2>
          <div className="key">
            <span className="chip b">−32.3</span> below the norm — possibly cheap
          </div>
          <div className="key">
            <span className="chip a">+116.7</span> above it — possibly stretched
          </div>
          <div className="key">
            <span className="chip n">48.9</span> inside the norm, or not yet judged
          </div>
          <p>
            Not red and green on purpose. Both ends are equally worth a look; the tool takes no view
            on which is good. A <span className="warm">*</span> marks a value still inside its
            warm-up window: shown, never judged.
          </p>
        </div>
        <div>
          <h2>Norms in force</h2>
          <dl>
            {norms
              .filter((n) => COLUMNS.some((c) => c.param === n.param))
              .map((n) => (
                <div key={n.param}>
                  <dt>{COLUMNS.find((c) => c.param === n.param)?.label ?? n.param}</dt>
                  <dd>{formatNorm(n)}</dd>
                </div>
              ))}
          </dl>
          <p>
            Edited in <code>config/norms.yml</code>, compared in the database so the grid, the
            digest and the rule engine cannot drift apart.
          </p>
        </div>
        <div>
          <h2>{norms.length - judged} norms with no column yet</h2>
          <p>
            {norms
              .filter((n) => !COLUMNS.some((c) => c.param === n.param))
              .map((n) => n.param)
              .join(", ") || "None — every norm has a parameter."}
          </p>
          <p className="muted">
            Weekly, market-context and fundamental parameters land in later passes. This list
            shrinks as they do.
          </p>
        </div>
      </div>

      <p className="note">
        “Off high” is measured against the highest price we <em>hold</em>, not an all-time high —
        the data plan carries five years, and several names on this list peaked in 2000.
        {status?.last_run_at ? (
          <>
            {" "}Most recent run of any kind:{" "}
            {new Date(status.last_run_at).toISOString().slice(0, 16).replace("T", " ")} UTC
            {status.last_run_by ? ` (${status.last_run_by})` : ""}
            {status.last_run_ok === false ? ", which reported a problem" : ""}. A config-only sync
            counts here but deliberately does not count as evidence that prices arrived.
          </>
        ) : null}
      </p>
    </main>
  );
}
