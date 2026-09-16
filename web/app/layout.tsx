/**
 * Root layout.
 *
 * Desktop-first (decision 0005, PROPOSAL §4 "Surfaces"): the scan is 26 columns across 36 names,
 * which is an information-density problem no responsive trick solves. The phone surface is the
 * email digest, not a squeezed version of this table. The table therefore gets its own horizontal
 * scroll container and the page body never scrolls sideways.
 *
 * Styles stay inline here rather than in a CSS module because there are two pages and one style
 * sheet. Move them out when a third page needs something different, not before.
 *
 * THEMING: light and dark are both defined at token level. The `:root` block holds the complete
 * light palette; the media query and the `[data-theme]` block only redefine tokens. A colour whose
 * only definition sits inside one of those blocks silently fails in the other state.
 */
import type { ReactNode } from "react";

export const metadata = {
  title: "Swing Tracker",
  description: "Watchlist tracker — the same parameters on every name, coloured against norms we set.",
};

// NOTE: CSS below is a template literal. A backtick inside it ENDS THE STRING, and the error you
// get is "Expected a semicolon" pointing at a line of prose, which reads like anything but the
// cause. Write .class-name in comments here, never `.class-name`. Cost twice on 2026-09-16.
const CSS = `
  :root {
    --paper:      #f6f8f7;
    --surface:    #ffffff;
    --ink:        #101719;
    --ink-soft:   #5d6d71;
    --ink-faint:  #8b9a9d;
    --rule:       #dde4e3;
    --rule-soft:  #eaefee;
    --accent:     #2a7d6f;
    /* Semantic, and deliberately not red/green. Below a norm means possibly cheap; above means
       possibly stretched. Both are equally interesting, so neither may look like a failure. */
    --below:      #1f6f8b;
    --below-bg:   #e4eff3;
    --above:      #a8661c;
    --above-bg:   #f7ede0;
    --warn:       #8a5a12;
    --warn-bg:    #fbf2e2;
    --err:        #9c3b2e;
    --shadow:     0 1px 2px rgba(16,23,25,.06), 0 8px 24px -16px rgba(16,23,25,.28);
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --paper:     #0d1416;
      --surface:   #141d1f;
      --ink:       #e7eeec;
      --ink-soft:  #9aabad;
      --ink-faint: #6b7d80;
      --rule:      #243134;
      --rule-soft: #1b2528;
      --accent:    #4fb3a1;
      --below:     #6fc0da;
      --below-bg:  #16303a;
      --above:     #e0a355;
      --above-bg:  #392a16;
      --warn:      #d9a55c;
      --warn-bg:   #332713;
      --err:       #e08878;
      --shadow:    0 1px 2px rgba(0,0,0,.4), 0 8px 24px -16px rgba(0,0,0,.8);
    }
  }
  :root[data-theme="dark"] {
    --paper:     #0d1416;
    --surface:   #141d1f;
    --ink:       #e7eeec;
    --ink-soft:  #9aabad;
    --ink-faint: #6b7d80;
    --rule:      #243134;
    --rule-soft: #1b2528;
    --accent:    #4fb3a1;
    --below:     #6fc0da;
    --below-bg:  #16303a;
    --above:     #e0a355;
    --above-bg:  #392a16;
    --warn:      #d9a55c;
    --warn-bg:   #332713;
    --err:       #e08878;
    --shadow:    0 1px 2px rgba(0,0,0,.4), 0 8px 24px -16px rgba(0,0,0,.8);
  }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--paper);
    color: var(--ink);
    font-family: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  main { max-width: 860px; margin: 0 auto; padding-block: 48px 72px; padding-inline: 20px; }
  /* Widened from 1500px on 2026-09-16, when relative strength made it sixteen columns.
     MEASURED, not guessed: the table needs 1726px, and at 1500 the newest column was the one
     permanently past the right edge — a feature nobody would find. 1800 fits the whole table on a
     1920 screen (measured: 1726px of table inside a 1760px container, 34px to spare, so a longer
     company name than any on the list today still fits). Narrower than that it scrolls, with the
     symbol column pinned, which
     is the behaviour this table has always had and the reason the page body never scrolls
     sideways. Density is the point of this page (decision 0005); the answer to more columns is a
     wider frame, not smaller type. */
  main.wide { max-width: 1800px; padding-block: 28px 64px; }

  h1 { font-family: "IBM Plex Sans Condensed", "IBM Plex Sans", sans-serif; font-weight: 700;
       font-size: clamp(26px, 5vw, 38px); letter-spacing: -.02em; margin: 0; text-wrap: balance; }
  .sub { color: var(--ink-soft); font-size: 14px; margin: 5px 0 0; max-width: 58ch; }
  .muted { color: var(--ink-faint); }
  .err { color: var(--err); font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
         font-size: 13px; word-break: break-word; }

  .head { display: flex; flex-wrap: wrap; gap: 18px 32px; align-items: flex-end;
          justify-content: space-between; padding-bottom: 16px; border-bottom: 2px solid var(--ink); }
  .status { display: flex; flex-wrap: wrap; gap: 10px 26px; }
  .stat { display: flex; flex-direction: column; gap: 1px; }
  .stat-k { font-family: "IBM Plex Sans Condensed", sans-serif; font-size: 10.5px;
            letter-spacing: .1em; text-transform: uppercase; color: var(--ink-faint); }
  .stat-v { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 15px;
            font-weight: 500; font-variant-numeric: tabular-nums; }

  .banner { margin-top: 18px; padding: 11px 14px; border-radius: 3px; font-size: 13.5px;
            border-left: 3px solid var(--warn); background: var(--warn-bg); color: var(--ink); }
  .banner b { font-weight: 600; }

  /* THE MARKET BLOCK. A strip of four tiles above the grid, because these are facts about the
     market rather than about any name and putting them in the table would imply otherwise.

     Tiles use the SAME --below/--above tokens as grid cells and the same 2.5px left rule, so a
     coloured tile and a coloured cell mean the same thing without a second legend. The .tile-d line is
     reserved even when empty (a non-breaking space) so the row of tiles does not change height
     when one of them starts carrying a date. */
  .market { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 1px; margin-top: 20px; background: var(--rule); border: 1px solid var(--rule);
            border-radius: 5px; overflow: hidden; box-shadow: var(--shadow); }
  .tile { background: var(--surface); padding: 11px 14px 9px; display: flex;
          flex-direction: column; gap: 1px; position: relative; }
  .tile.mark::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2.5px; }
  .tile.below { background: var(--below-bg); color: var(--below); }
  .tile.above { background: var(--above-bg); color: var(--above); }
  .tile.below::before { background: var(--below); }
  .tile.above::before { background: var(--above); }
  .tile-k { font-family: "IBM Plex Sans Condensed", sans-serif; font-size: 10.5px;
            letter-spacing: .1em; text-transform: uppercase; color: var(--ink-faint); }
  .tile.mark .tile-k { color: inherit; opacity: .8; }
  .tile-v { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 19px;
            font-weight: 500; font-variant-numeric: tabular-nums; line-height: 1.25; }
  .tile-d { font-family: ui-monospace, Menlo, monospace; font-size: 10px; color: var(--ink-faint);
            min-height: 14px; }
  .tile.mark .tile-d { color: inherit; opacity: .75; }
  .market-err { grid-column: 1 / -1; background: var(--surface); padding: 11px 14px;
                font-size: 13px; border-left: 3px solid var(--warn); }

  .panel { background: var(--surface); border: 1px solid var(--rule); border-radius: 6px;
           padding: 20px 22px; margin-top: 22px; box-shadow: var(--shadow); }
  .panel h2 { font-family: "IBM Plex Sans Condensed", sans-serif; font-size: 11px;
              text-transform: uppercase; letter-spacing: .1em; color: var(--ink-faint);
              margin: 0 0 12px; font-weight: 600; }
  .panel p { margin: 0 0 8px; }
  .panel table { width: 100%; border-collapse: collapse; font-size: 14px; }
  .panel td { padding: 7px 0; border-bottom: 1px solid var(--rule-soft); vertical-align: top; }
  .panel tr:last-child td { border-bottom: 0; }
  .panel td:first-child { color: var(--ink-soft); width: 46%; }

  .scroll { margin-top: 26px; overflow-x: auto; border: 1px solid var(--rule); border-radius: 4px;
            background: var(--surface); box-shadow: var(--shadow); }
  table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
  thead th { position: sticky; top: 0; z-index: 3; background: var(--surface);
             font-family: "IBM Plex Sans Condensed", sans-serif; font-weight: 600; font-size: 11px;
             letter-spacing: .06em; text-transform: uppercase; color: var(--ink-soft);
             text-align: right; padding: 12px 12px 9px; border-bottom: 1.5px solid var(--rule);
             white-space: nowrap; }
  thead th.sym { text-align: left; left: 0; z-index: 4; }

  /* WHERE THE LEFTOVER WIDTH GOES — and why this table is NOT width:100%.

     It was, and on a screen wider than the columns need the browser handed every spare pixel to
     the LAST column. Since 2026-09-16 that is relative strength: one column stretched to ~350px
     with its number marooned at the right edge and a gulf between it and the weekly block, which
     read as a layout bug and hid the fact that the two groups are adjacent.

     The fix is width:100% on the SYMBOL column, which makes that the cell the surplus is handed
     to. Every numeric column keeps its natural width, the three groups stay adjacent, the table
     still fills the frame (so band rows and hover highlights run its full width), and the slack
     lands on the company names — the only cells that can use it.

     Two things tried and rejected, both recorded because each looked right in isolation:
       width:max-content     stops the table at its natural width and leaves an empty strip inside
                             the container's border where the striped rows should run.
       + min-width:max-content on top of width:100%, with the symbol column at width:100% — the
                             three constraints are circular and the symbol column resolved to
                             998,612px. Measured, not theorised. */
  .scroll table th.sym, .scroll table td.sym { width: 100%; }

  /* TWO HEADER ROWS. The group row pins at the top and the label row pins directly beneath it.
     A sticky element cannot measure its sibling, so the label row's offset is the group row's own
     fixed height, written as a literal. The two numbers must move together, which is why they sit
     three lines apart rather than in separate rules. */
  thead tr.grp th { top: 0; height: 26px; box-sizing: border-box; padding: 6px 12px 5px;
                    font-size: 10px; letter-spacing: .1em; color: var(--ink-faint);
                    text-align: center; border-bottom: 1px solid var(--rule-soft); }
  thead tr.grp th.sym { border-bottom: none; }
  thead tr:not(.grp) th { top: 26px; }

  /* The daily/weekly divider. One rule, full height, so the eye can tell at a glance which side of
     it a number lives on - "vs 21 EMA" appears on both and means different things. */
  thead th.grp-start, tbody td.grp-start { border-left: 1.5px solid var(--rule); }
  /* The as-of line under the RS heading. Same slot as a norm, distinguished by weight rather than
     colour so it does not read as a warning: RS being a session behind is the normal evening state,
     not a fault. */
  thead th .norm.asof { font-style: italic; }
  thead th .norm { display: block; font-family: ui-monospace, Menlo, monospace; font-size: 9.5px;
                   letter-spacing: 0; text-transform: none; color: var(--ink-faint);
                   font-weight: 400; margin-top: 2px; }

  tbody td { padding: 7px 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
             font-size: 13px; text-align: right; border-bottom: 1px solid var(--rule-soft);
             white-space: nowrap; }
  tbody td.sym { position: sticky; left: 0; background: var(--surface); text-align: left;
                 font-weight: 600; font-size: 13.5px; z-index: 2; }
  tbody td.sym .co { display: block; font-family: "IBM Plex Sans", sans-serif; font-weight: 400;
                     font-size: 11px; color: var(--ink-faint); }
  tbody tr:hover td, tbody tr:hover td.sym { background: var(--rule-soft); }

  tr.band td { background: var(--paper); padding: 9px 12px 7px;
               font-family: "IBM Plex Sans Condensed", sans-serif; font-size: 11px; font-weight: 600;
               letter-spacing: .1em; text-transform: uppercase; color: var(--ink-soft);
               text-align: left; border-top: 1px solid var(--rule);
               border-bottom: 1px solid var(--rule); }
  tr.band td .n { font-family: ui-monospace, Menlo, monospace; color: var(--ink-faint);
                  font-weight: 400; letter-spacing: 0; margin-left: 8px; }

  /* Severity in form as well as colour, so it survives greyscale and colourblindness. */
  tbody td.mark { position: relative; font-weight: 600; }
  tbody td.below { color: var(--below); background: var(--below-bg); }
  tbody td.above { color: var(--above); background: var(--above-bg); }
  tbody td.mark::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2.5px; }
  tbody td.below::before { background: var(--below); }
  tbody td.above::before { background: var(--above); }
  tbody td.unjudged { color: var(--ink-faint); }
  .bell { color: var(--accent); font-size: 10px; vertical-align: 3px; margin-left: 3px; }
  .warm { color: var(--warn); margin-left: 2px; }

  .foot { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
          gap: 22px 34px; margin-top: 30px; }
  .foot h2 { font-family: "IBM Plex Sans Condensed", sans-serif; font-size: 11px;
             letter-spacing: .1em; text-transform: uppercase; color: var(--ink-faint);
             margin: 0 0 8px; font-weight: 600; }
  .foot p { margin: 8px 0 0; font-size: 13px; color: var(--ink-soft); }
  .key { display: flex; align-items: center; gap: 8px; font-size: 13px; margin-bottom: 6px; }
  .chip { display: inline-block; padding: 1px 7px; border-radius: 2px; font-size: 11.5px;
          font-family: ui-monospace, Menlo, monospace; font-weight: 500; border-left: 2.5px solid; }
  .chip.b { color: var(--below); background: var(--below-bg); border-color: var(--below); }
  .chip.a { color: var(--above); background: var(--above-bg); border-color: var(--above); }
  .chip.n { color: var(--ink-faint); background: transparent; border-color: var(--rule); }
  dl { margin: 0; font-size: 12.5px; }
  dl div { display: flex; justify-content: space-between; gap: 14px; padding: 3px 0;
           border-bottom: 1px solid var(--rule-soft); }
  dt { color: var(--ink-soft); }
  dd { margin: 0; font-family: ui-monospace, Menlo, monospace; color: var(--ink); }

  .note { margin-top: 26px; padding-top: 16px; border-top: 1px solid var(--rule);
          font-size: 12.5px; color: var(--ink-faint); max-width: 78ch; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
  a { color: var(--accent); }
  a:focus-visible, :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .yes { color: var(--accent); }
  .no { color: var(--warn); }
  footer { color: var(--ink-faint); font-size: 13px; margin-top: 32px; }
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Condensed:wght@600;700&family=IBM+Plex+Sans:wght@400;500;600&display=swap"
        />
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
