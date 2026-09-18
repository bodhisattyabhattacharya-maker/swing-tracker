/**
 * Deep Dive — not built yet, and saying so rather than showing a convincing shell.
 *
 * The design for this tab is a horizontally scrolling strip of per-stock cards: price chart with
 * moving-average overlays, three RSI gauges, the MA signal strip, price-stat mini-plots, a weekly
 * panel, relative-strength bars and the fundamentals panels. It needs a charting layer the project
 * does not have yet, and the fundamentals it ends with do not exist.
 *
 * An empty shell with skeleton cards would read as a loading failure. The spec is explicit about
 * that distinction for cells — "once the page is loaded, stable non-data states replace skeletons
 * so the interface never appears unfinished" — and the same rule applies to a whole tab.
 */
export const revalidate = 900;

export default function DeepDive() {
  return (
    <main>
      <h1>Deep Dive</h1>
      <p className="sub">
        One analysis column per stock, side by side. Not built yet — this is a placeholder that
        says so rather than a shell that looks broken.
      </p>

      <div className="panel">
        <h2>What lands here</h2>
        <ul className="plan">
          <li>Price chart with EMA21 / SMA50 / SMA200 / SMA30W / SMA200W overlays and a D/W toggle</li>
          <li>MA signal strip — stack, both crosses with bars since, both slopes <em>(data ready)</em></li>
          <li>Hourly, daily and weekly RSI gauges <em>(hourly blocked on session-aligned bars)</em></li>
          <li>Price-stat history cards — distance from highs, volume ratio, realised volatility</li>
          <li>Weekly technicals panel <em>(data ready)</em></li>
          <li>Relative-strength bars at 63, 126 and 252 bars <em>(data ready)</em></li>
          <li>Fundamentals and Forward Look panels <em>(blocked on the financials ingest)</em></li>
        </ul>
        <p className="muted">
          Three of the seven sections have their data already. The blocker is a charting layer,
          which arrives with the market-history charts on the Dashboard — those come first because
          they serve every name at once rather than one at a time.
        </p>
      </div>
    </main>
  );
}
