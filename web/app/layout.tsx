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
import Tabs from "../components/Tabs";

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
    /* Planned is lavender-neutral on purpose: adjacent to nothing else on the page, so the marker
       can never be misread as a verdict or as a warning. It is used in the column HEADING only -
       see .tag near the cell states for why the per-cell fill was dropped. */
    --plan:       #6a5f8c;
    /* The edge shadow on the horizontal scroller. A scrim, not a colour: it darkens whatever cell
       background happens to be under it, which is the only thing that works over a table whose
       rows, bands and judged cells all paint differently. Heavier in dark mode - the same black at
       .13 is invisible against #141d1f. */
    --scrim:      rgba(16,23,25,.16);
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
      --plan:      #a99cd0;
      --scrim:     rgba(0,0,0,.55);
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
    --plan:      #a99cd0;
    --scrim:     rgba(0,0,0,.55);
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
     MEASURED, not guessed. 2026-09-16: the table needed 1726px and the frame was 1500, so the
     newest column sat permanently past the right edge; the frame went to 1800 and it fitted.

     2026-09-17 AND THE REASON THE FRAME DID NOT GROW AGAIN: the presets put the Momentum set at 16
     columns and 1859px, which is 101px more than the 1758px this frame leaves inside the table's
     border. The obvious move was 1900. It was measured and rejected: a 1920 viewport with a
     scrollbar leaves 1905px, so 1901px of frame fits with four pixels to spare, and the very next
     column puts it back over. The All preset is 51 columns; no frame fits that. Chasing the widest
     preset is a race the table wins every time.

     So the frame stays at a deliberate reading width and the SCROLL is made findable instead — the
     fade at the right edge of .scroll, below. That was the actual defect on 2026-09-16 and it was
     described correctly at the time: "a feature nobody would find". Widening the frame hid that
     symptom for one column set. Density is the point of this page (decision 0005). */
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

  /* THE SCROLLER, AND THE EDGE SHADOW THAT SAYS IT IS ONE.

     A table wider than its frame is normal here and always will be. What is not acceptable is a
     table that ENDS at the container edge with nothing to say there is more, which is how relative
     strength stayed invisible on 2026-09-16 at every width. This is the affordance: it appears
     only when there is content to the right and goes out at the end of the scroll, so it states a
     fact rather than decorating an edge.

     A SHADOW, NOT A FADE TO --surface, and that was a correction. The first version painted a
     gradient from --surface to transparent, which works only where --surface is what is underneath
     — and inside this table it often is not: band rows are --paper, judged cells carry their own
     tint, and pinned cells paint their own background. On a dark screen at 1280 the result was not
     a fade but an ERASURE: a 46px strip of "VOL RATIO" and of the pinned theme label were painted
     over in flat surface colour, which read as a rendering bug. A scrim darkens whatever is beneath
     it and cannot get the colour wrong, because it does not claim one.

     There is also no left-hand counterpart any more. Its only message was "you can scroll back",
     which the scrollbar and the pinned symbol column both already say, and being on the left it sat
     over the one thing that must never be obscured: the row's identity.

     A sibling overlay rather than a background on .scroll, because the table paints over the
     container. pointer-events:none so it cannot swallow a click on the cell beneath it. */
  .scrollwrap { position: relative; }
  .scrollwrap .fade { position: absolute; top: 0; bottom: 1px; width: 40px; pointer-events: none;
                      opacity: 0; transition: opacity .12s ease; z-index: 6; }
  .scrollwrap .fade.r { right: 1px; border-top-right-radius: 4px; border-bottom-right-radius: 4px;
                        background: linear-gradient(to left, var(--scrim), transparent); }
  .scrollwrap.more-r .fade.r { opacity: 1; }

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

  /* Severity in form as well as colour, so it survives greyscale and colourblindness.
     THESE ARE .st-below / .st-above, NOT .below / .above. The cell's class list is built as
     "cell st-<state> mark" (ParameterGrid's Cell), so the bare selectors these replaced - left over
     from the pre-preset grid, where the class WAS bare - matched nothing: every judged cell drew
     the 2.5px rule with no background on it and no tint behind the number. It compiled, it built,
     and it was invisible until the states were enumerated. scripts/ci/check_cell_states.sh now
     asserts each state has a rule that can reach it. */
  tbody td.mark { position: relative; font-weight: 600; }
  tbody td.st-below { color: var(--below); background: var(--below-bg); }
  tbody td.st-above { color: var(--above); background: var(--above-bg); }
  tbody td.mark::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2.5px; }
  tbody td.st-below::before { background: var(--below); }
  tbody td.st-above::before { background: var(--above); }
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

  /* ---------------------------------------------------------------------
     THE FRAME. Header is quiet and persistent; the body owns its own
     scrolling in both axes. The active tab is unmistakable through contrast
     and an understated accent, not a heavy filled button.
     --------------------------------------------------------------------- */
  .frame { position: sticky; top: 0; z-index: 20; display: flex; align-items: center;
           gap: 26px; padding: 0 20px; height: 48px; background: var(--surface);
           border-bottom: 1px solid var(--rule); }
  .brand { font-family: "IBM Plex Sans Condensed", sans-serif; font-weight: 700; font-size: 14px;
           letter-spacing: .02em; }
  .tabs { display: flex; gap: 2px; }
  .tab { display: flex; align-items: center; gap: 7px; height: 47px; padding: 0 14px;
         font-family: ui-monospace, Menlo, monospace; font-size: 12.5px; color: var(--ink-faint);
         text-decoration: none; border-bottom: 2px solid transparent; }
  .tab:hover { color: var(--ink-soft); }
  .tab.on { color: var(--ink); border-bottom-color: var(--accent); }
  .tabicon { font-size: 13px; opacity: .7; }
  main { padding-block: 24px 64px; }

  /* ---------------------------------------------------------------------
     CONTROLS. One compact row: filter, preset segments, and a hint. They may
     scroll horizontally as one row on a phone; they never wrap into a tall
     control block that pushes the table off screen.
     --------------------------------------------------------------------- */
  .controls { display: flex; align-items: center; gap: 14px; margin-top: 18px;
              padding-bottom: 12px; overflow-x: auto; }
  .find { flex: 0 0 240px; padding: 6px 10px; font-size: 13px; font-family: inherit;
          color: var(--ink); background: var(--surface); border: 1px solid var(--rule);
          border-radius: 4px; }
  .find::placeholder { color: var(--ink-faint); }
  .presets { display: flex; gap: 1px; padding: 2px; background: var(--rule-soft);
             border-radius: 5px; flex: 0 0 auto; }
  .seg { padding: 5px 12px; font-family: ui-monospace, Menlo, monospace; font-size: 12px;
         color: var(--ink-soft); background: transparent; border: 0; border-radius: 4px;
         cursor: pointer; white-space: nowrap; }
  .seg:hover { color: var(--ink); }
  .seg.on { background: var(--ink); color: var(--paper); }
  .hint { margin-left: auto; font-size: 11.5px; color: var(--ink-faint); white-space: nowrap; }

  /* Sortable header: a button so it is reachable by keyboard, styled as the label. */
  .sorter { display: inline-flex; align-items: baseline; gap: 5px; padding: 0; border: 0;
            background: none; font: inherit; color: inherit; letter-spacing: inherit;
            text-transform: inherit; cursor: pointer; }
  .sorter:hover { color: var(--ink); }
  .tf { font-size: 8.5px; letter-spacing: .08em; color: var(--ink-faint); border: 1px solid var(--rule);
        border-radius: 2px; padding: 0 3px; }
  .dir { color: var(--accent); font-size: 10px; }
  thead th .norm.plan { color: var(--plan); font-style: normal; letter-spacing: .06em; }
  thead tr.grp th .asof { display: block; font-family: ui-monospace, Menlo, monospace;
                          font-size: 9px; font-style: italic; letter-spacing: 0;
                          text-transform: none; color: var(--ink-faint); }

  /* Collapsible theme band. The chevron communicates state; collapsing removes member rows
     without changing sorting or preset.

     STICKY LEFT, for the same reason the symbol column is. The band's cell spans the whole table,
     so at any scroll position past zero its label had scrolled out of the viewport and the theme
     dividers became three blank grey strips - the reader lost the map of the page at exactly the
     moment they were exploring it. Seen at 1440 scrolled right, not in any measurement.

     width:max-content, not 100%: a sticky child only detaches from the scroll if it is narrower
     than its container, and at width:100% it is exactly as wide as the table. */
  .bandbtn { display: flex; align-items: center; gap: 8px; width: max-content; padding: 0;
             border: 0; position: sticky; left: 12px;
             background: none; font: inherit; color: inherit; letter-spacing: inherit;
             text-transform: inherit; text-align: left; cursor: pointer; }
  .chev { color: var(--ink-faint); font-size: 9px; width: 9px; }

  /* ---------------------------------------------------------------------
     CELL STATES. Seven of them, and each is a different sentence. Colour is
     reinforced by label, pattern or detail text - never colour alone.
     --------------------------------------------------------------------- */
  td.cell { padding: 0; }
  .cellbtn { display: block; width: 100%; padding: 7px 12px; border: 0; background: none;
             font: inherit; color: inherit; text-align: right; cursor: pointer; }
  td.st-null, td.st-na, td.st-planned, td.st-no-norm { color: var(--ink-faint); }
  td.st-normal { color: var(--ink); }
  td.st-warmup { color: var(--warn); }
  .dash { color: var(--ink-faint); }
  .unit { font-size: 10px; color: var(--ink-faint); margin-left: 1px; }

  /* Not-applicable is the only per-ROW marker left in a cell: an outline, never a fill, because we
     are declining to ask the question rather than reporting an answer.

     There is no .tag.plan any more. Planned is a statement about the COLUMN, so it is made once in
     the column heading (thead th .norm.plan, above) rather than 312 times on the Value preset,
     which is what it came to on screen. Bodhi, 2026-09-18. */
  .tag { font-family: "IBM Plex Sans Condensed", sans-serif; font-size: 9px; letter-spacing: .08em;
         text-transform: uppercase; padding: 1px 5px; border-radius: 2px; }
  .tag.na { color: var(--ink-faint); background: transparent; border: 1px dashed var(--rule); }
  /* The word "planned" where the footnote quotes a column heading, so the sentence points at
     something the reader can actually find on the screen above it. */
  .planword { color: var(--plan); font-family: "IBM Plex Sans Condensed", sans-serif;
              font-size: 11px; letter-spacing: .06em; text-transform: uppercase; }
  /* No norm: a tracked value with no threshold. Outlined rather than tinted - we have no opinion. */
  td.st-no-norm .cellbtn { text-decoration: underline; text-decoration-style: dotted;
                           text-decoration-color: var(--rule); text-underline-offset: 4px; }

  /* Categorical chips: label and number are one fact, so they sit together. */
  .chip { font-family: "IBM Plex Sans Condensed", sans-serif; font-size: 10.5px;
          letter-spacing: .04em; padding: 1px 6px; border-radius: 9px; background: var(--rule-soft);
          color: var(--ink-soft); }
  td.st-above .chip { background: var(--above-bg); color: var(--above); }
  td.st-below .chip { background: var(--below-bg); color: var(--below); }
  .chipnum { margin-left: 6px; font-size: 11.5px; color: var(--ink-faint); }

  /* ---------------------------------------------------------------------
     CELL DETAIL SHEET. Opens over the table without leaving it. On a phone
     this becomes a bottom sheet; on desktop it is centred and modest.
     --------------------------------------------------------------------- */
  .sheetwrap { position: fixed; inset: 0; z-index: 40; display: flex; align-items: center;
               justify-content: center; padding: 20px; background: rgba(16,23,25,.34); }
  .sheet { width: min(560px, 100%); max-height: 84vh; overflow: auto; background: var(--surface);
           border: 1px solid var(--rule); border-radius: 8px; box-shadow: var(--shadow);
           padding: 20px 22px; }
  .sheethead { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
  .sheet h3 { margin: 0; font-family: "IBM Plex Sans Condensed", sans-serif; font-size: 18px; }
  .sheet .muted { margin: 2px 0 0; font-size: 12.5px; }
  .x { border: 0; background: none; font-size: 22px; line-height: 1; color: var(--ink-faint);
       cursor: pointer; padding: 0 2px; }
  .sheetstats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; margin-top: 16px;
                background: var(--rule); border: 1px solid var(--rule); border-radius: 5px;
                overflow: hidden; }
  .sheetstats > div { background: var(--surface); padding: 9px 12px; display: flex;
                      flex-direction: column; gap: 2px; }
  .sheetstats .k { font-family: "IBM Plex Sans Condensed", sans-serif; font-size: 9.5px;
                   letter-spacing: .1em; text-transform: uppercase; color: var(--ink-faint); }
  .sheetstats .v { font-family: ui-monospace, Menlo, monospace; font-size: 14px; }
  .why { margin: 14px 0 0; font-size: 13px; }
  .sheet .note { margin-top: 14px; padding-top: 12px; font-size: 12px; }

  .plan { margin: 0; padding-left: 18px; font-size: 13.5px; }
  .plan li { margin-bottom: 5px; }
  .plan em { color: var(--ink-faint); font-size: 12.5px; }

  /* A phone keeps the same two mental models: a horizontally navigable table and a horizontally
     swiped stock strip. Never a vertical card feed - that destroys comparison. */
  @media (max-width: 720px) {
    .controls { gap: 10px; }
    .find { flex-basis: 150px; }
    .hint { display: none; }
    .sheetwrap { align-items: flex-end; padding: 0; }
    .sheet { width: 100%; max-height: 88vh; border-radius: 10px 10px 0 0; }
  }
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
      <body>
        {/* The persistent application frame. Two tabs carry the entire product: Dashboard answers
            "what is happening across the universe", Deep Dive answers "what is happening inside
            these names". No third workflow competes with those two. */}
        <header className="frame">
          <span className="brand">Swing Tracker</span>
          <Tabs />
        </header>
        {children}
      </body>
    </html>
  );
}
