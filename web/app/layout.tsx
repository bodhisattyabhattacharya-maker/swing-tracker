/**
 * Root layout.
 *
 * Desktop-first (decision 0005, PROPOSAL §4 "Surfaces"): the scan is a 51-column catalogue across
 * 53 names, which is an information-density problem no responsive trick solves. The phone surface
 * is the email digest, not a squeezed version of this table. The table therefore gets its own
 * horizontal scroll container and the page body never scrolls sideways; so does the Deep Dive
 * strip, which is 53 columns of 420px and must never collapse into a vertical feed.
 *
 * Styles stay inline here rather than in a CSS module because there is one stylesheet for three
 * pages. THIS IS NOW THE LARGEST FILE IN web/ and the argument for splitting it gets better every
 * change; the reason not to yet is that every colour in it is a token defined at the top, and a
 * split that separates a token from the rules that use it costs more than it saves. Split by
 * SURFACE (grid / strip / charts) when it happens, never by property.
 *
 * THEMING: light and dark are both defined at token level. The `:root` block holds the complete
 * light palette; the media query and the `[data-theme]` block only redefine tokens. A colour whose
 * only definition sits inside one of those blocks silently fails in the other state.
 */
import type { ReactNode } from "react";
import Tabs from "../components/Tabs";
import ThemeToggle from "../components/ThemeToggle";

export const metadata = {
  title: "Swing Tracker",
  description: "Watchlist tracker — the same parameters on every name, coloured against norms we set.",
};

// NOTE: CSS below is a template literal. A backtick inside it ENDS THE STRING, and the error you
// get is "Expected a semicolon" pointing at a line of prose, which reads like anything but the
// cause. Write .class-name in comments here, never `.class-name`. Cost twice on 2026-09-16.
const CSS = `
  :root {
    /* THE ATELIER PALETTE (Bodhi, 2026-09-19, decision 0052). Warm cream paper and warm near-black
       ink, not the cool grey-green this page opened with. Every value below is a token because the
       charts read these same names at runtime through lib/chart-theme.ts - see THEMING above. */
    --paper:      #f4f1ea;
    --surface:    #fdfcf8;
    --ink:        #1b1815;
    --ink-soft:   #575046;
    --ink-faint:  #6f6759;
    --rule:       #e2dbce;
    --rule-soft:  #eee9de;
    --accent:     #875d34;

    /* VERDICTS ARE RED AND GREEN, AND THAT REVERSED AN EARLIER DECISION.
       Until 2026-09-19 these were blue and ochre, on the reasoning that below a norm means possibly
       cheap and above means possibly stretched, so neither should look like a failure. The design
       spec pre-empts that objection rather than ignoring it: red and green here express the
       RELATIONSHIP TO A RULE, not a recommendation, which is why this product still has no arrow, no
       buy or sell, no rank and no composite score. Colour is never the only carrier - every judged
       cell also has the 2.5px left rule, the norm printed in its heading, and the number itself.

       MUTED, not signal red and signal green: these sit behind text and must stay legible at 13px,
       which saturated versions do not. scripts/ci/check_contrast.sh enumerates every state against
       its own background in both themes and fails under 4.5:1 - a tint that fails against its own
       text is this palette's failure mode and it is not something to catch by eye. */
    --below:      #a03c33;
    --below-bg:   #f7e9e5;
    --above:      #3f6b4a;
    --above-bg:   #e7efe6;

    --warn:       #8a5f18;
    --warn-bg:    #f9f0dc;
    --err:        #9c3b2e;

    /* THE INTENSITY SCALE. Calm and stressed, and these two exist so that red and green can keep
       exactly one meaning across the product: a security against its norm.
       VIX broke that. Its band is 16-30, so on the verdict scale a calm tape at 14 painted red and
       a stressed one at 34 painted green - backwards to anyone who has looked at a volatility
       chart, and read by the eye before the number beside it. Inverting VIX alone would have been
       an exception inside the mapping, which is how a palette stops meaning anything; giving the
       market's temperature its own two colours is not. Slate and amber, used by the VIX tile and
       the regime strip and nowhere else. See lib/market.ts, above MARKET_TILES. */
    --calm:       #3a6d8c;
    --calm-bg:    #e6eef3;
    --stress:     #9d4c1b;
    --stress-bg:  #f9ebdd;

    /* THE FIVE-STEP REGIME RAMP, for the VIX strip and the bands behind the VIX line.
       Anchored at both ends on the intensity pair above: --reg-calm IS --calm and
       --reg-stress IS --stress, so the strip, the VIX tile and the bands all say "calm" and
       "stressed" in one vocabulary rather than three that happen to look similar. The three steps
       between and beyond are interpolations of that same slate-to-rust path.
       NOT the verdict pair: red and green mean "outside a norm we set", and a calm tape is not a
       verdict (decision 0052, and the note above MARKET_TILES). */
    /* The fill a regime element paints with. Overridden per band by the .r-* classes; the default
       here is not decoration but a floor - a swatch that somehow reaches the page without a band
       class renders grey rather than invisible, which is a visible bug instead of a silent one.
       It resolves through --ink-faint, so it follows the theme without a second definition. */
    --band-ink:    var(--ink-faint);
    --reg-calm:    #3a6d8c;
    --reg-normal:  #9a8f7e;
    --reg-high:    #c0762c;
    --reg-stress:  #9d4c1b;
    --reg-extreme: #6b2411;
    /* Planned is lavender-neutral on purpose: adjacent to nothing else on the page, so the marker
       can never be misread as a verdict or as a warning. It is used in the column HEADING only -
       see .tag near the cell states for why the per-cell fill was dropped. */
    --plan:       #6a5f8c;

    /* MOVING-AVERAGE OVERLAY LINES. THESE EXIST BECAUSE OF THE RED/GREEN SWAP, and the reason is
       worth keeping: the three overlays used to draw in --accent, --below and --above, which was
       harmless while those were teal, blue and ochre. The moment verdicts became red and green, the
       50-day average would have drawn in verdict red and the 200-day in verdict green - colour with
       no judgement behind it, on a chart where every other use of those two hues means a norm was
       crossed. An overlay is a reference line, not a verdict, so it gets its own hues: warm brass,
       slate, plum. Distinguishable from each other, and from both verdict colours. */
    --ma1:        #8a5e25;
    --ma2:        #3a6d8c;
    --ma3:        #7b5d8f;

    /* GROUP RAILS. One quiet hue per category band, drawn as a 3px rule along the top of the group
       heading. This is what makes a 51-column table navigable: the eye finds REVENUE by colour and
       position long before it can read nine small-caps labels. Desaturated on purpose - a rail is a
       landmark, and a saturated one would compete with the judged cells underneath it.
       FORWARD LOOK IS GREY, and that is not laziness: no vendor sells consensus at any tier, so
       that band is permanently planned and a colour promising otherwise would be a lie. */
    --g-price:      #7a6a55;
    --g-techdaily:  #3a6d8c;
    --g-techweekly: #1f4d5c;
    --g-ma:         #5c7a6a;
    --g-relative:  #8a6a3f;
    --g-revenue:   #6b5f8c;
    --g-profit:    #8a5f6a;
    --g-valuation: #4f7a7a;
    --g-quality:   #77773f;
    --g-forward:   #93897c;

    /* TYPE. Serif for titles, sans for interface labels, mono for every number - the numerals are
       tabular everywhere so a column cannot jitter as values change. Named as tokens so the three
       families are one decision; the serif degrades to whatever the platform has if the webfont
       does not load, which is a fallback chain rather than a silent swap to sans. */
    --serif:      "Spectral", "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
    --sans:       "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
    --sans-cond:  "IBM Plex Sans Condensed", "IBM Plex Sans", sans-serif;
    --mono:       ui-monospace, SFMono-Regular, Menlo, monospace;

    /* The edge shadow on the horizontal scroller. A scrim, not a colour: it darkens whatever cell
       background happens to be under it, which is the only thing that works over a table whose
       rows, bands and judged cells all paint differently. Heavier in dark mode - the same black at
       .13 is invisible against a dark surface. */
    --scrim:      rgba(27,24,21,.16);
    --shadow:     0 1px 2px rgba(27,24,21,.05), 0 10px 28px -18px rgba(27,24,21,.24);
  }

  /* DARK IS DEEP WARM CHARCOAL AND SOFT IVORY, never pure black on pure white: the spec asks for
     the same paper in a dim room, and #000 against #fff is a different material. Only tokens are
     redefined here - a colour whose sole definition sits in one of these blocks silently fails in
     the other state, which is the trap the THEMING note at the top of this file describes. */
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --paper:     #16130f;
      --surface:   #1f1b16;
      --ink:       #ece5d8;
      --ink-soft:  #b7ad9d;
      --ink-faint: #978e80;
      --rule:      #332c24;
      --rule-soft: #26211a;
      --accent:    #c79a62;
      --below:     #e2897b;
      --below-bg:  #3a211d;
      --above:     #82b68c;
      --above-bg:  #1d3123;
      --warn:      #d9a55c;
      --warn-bg:   #332713;
      --err:       #e08878;
      --calm:      #78b4d4;
      --calm-bg:   #172b34;
      --stress:    #e0a05c;
      --stress-bg: #372213;

      --reg-calm:    #78b4d4;
      --reg-normal:  #a89b86;
      --reg-high:    #d79a52;
      --reg-stress:  #e0a05c;
      --reg-extreme: #c9714a;
      --plan:      #a99cd0;
      --ma1:       #d6a55e;
      --ma2:       #78b4d4;
      --ma3:       #b69bd0;
      --g-price:      #a99781;
      --g-techdaily:  #79aac7;
      --g-techweekly: #4d8a9e;
      --g-ma:         #8fb3a0;
      --g-relative:  #c2a173;
      --g-revenue:   #a396c6;
      --g-profit:    #c295a1;
      --g-valuation: #83b2b2;
      --g-quality:   #adad72;
      --g-forward:   #9c9287;
      --scrim:     rgba(0,0,0,.55);
      --shadow:    0 1px 2px rgba(0,0,0,.4), 0 10px 28px -18px rgba(0,0,0,.8);
    }
  }
  :root[data-theme="dark"] {
    --paper:     #16130f;
    --surface:   #1f1b16;
    --ink:       #ece5d8;
    --ink-soft:  #b7ad9d;
    --ink-faint: #978e80;
    --rule:      #332c24;
    --rule-soft: #26211a;
    --accent:    #c79a62;
    --below:     #e2897b;
    --below-bg:  #3a211d;
    --above:     #82b68c;
    --above-bg:  #1d3123;
    --warn:      #d9a55c;
    --warn-bg:   #332713;
    --err:       #e08878;
    --calm:      #78b4d4;
    --calm-bg:   #172b34;
    --stress:    #e0a05c;
    --stress-bg: #372213;

    --reg-calm:    #78b4d4;
    --reg-normal:  #a89b86;
    --reg-high:    #d79a52;
    --reg-stress:  #e0a05c;
    --reg-extreme: #c9714a;
    --plan:      #a99cd0;
    --ma1:       #d6a55e;
    --ma2:       #78b4d4;
    --ma3:       #b69bd0;
    --g-price:      #a99781;
    --g-techdaily:  #79aac7;
    --g-techweekly: #4d8a9e;
    --g-ma:         #8fb3a0;
    --g-relative:  #c2a173;
    --g-revenue:   #a396c6;
    --g-profit:    #c295a1;
    --g-valuation: #83b2b2;
    --g-quality:   #adad72;
    --g-forward:   #9c9287;
    --scrim:     rgba(0,0,0,.55);
    --shadow:    0 1px 2px rgba(0,0,0,.4), 0 10px 28px -18px rgba(0,0,0,.8);
  }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--paper);
    color: var(--ink);
    font-family: var(--sans);
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
    /* TABULAR EVERYWHERE, SET ONCE AND INHERITED. Nine rules used to ask for this individually and
       the ones that did not were the ones that jittered: a column of proportional digits changes
       width as its values change, which on a table read by scanning down a column is movement with
       no meaning behind it. Inheriting it means a new number cannot forget. */
    font-variant-numeric: tabular-nums;
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

  /* SERIF FOR TITLES. The spec's voice: a serif display face for the things that name the product
     and its sections, sans for the interface around them, mono for every number. The distinction is
     doing work rather than decorating - a serif line is never a control, so the reader learns that
     anything in the serif is a title and everything clickable is not. */
  h1 { font-family: var(--serif); font-weight: 600;
       font-size: clamp(26px, 5vw, 38px); letter-spacing: -.01em; margin: 0; text-wrap: balance; }
  .sub { color: var(--ink-soft); font-size: 14px; margin: 5px 0 0; max-width: 58ch; }
  .muted { color: var(--ink-faint); }
  .err { color: var(--err); font-family: var(--mono);
         font-size: 13px; word-break: break-word; }

  .head { display: flex; flex-wrap: wrap; gap: 18px 32px; align-items: flex-end;
          justify-content: space-between; padding-bottom: 16px; border-bottom: 2px solid var(--ink); }
  .status { display: flex; flex-wrap: wrap; gap: 10px 26px; }
  .stat { display: flex; flex-direction: column; gap: 1px; }
  .stat-k { font-family: var(--sans-cond); font-size: 10.5px;
            letter-spacing: .1em; text-transform: uppercase; color: var(--ink-faint); }
  .stat-v { font-family: var(--mono); font-size: 15px;
            font-weight: 500; font-variant-numeric: tabular-nums; }
  /* A stat that only appears when something is off should look like it. */
  .stat-v.warnv { color: var(--warn); }

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
  /* The intensity scale. Same shape as the two above - tint plus the 2.5px rule - because the tile
     is making the same KIND of statement, that a value is outside a band we set. Only the
     vocabulary differs. */
  .tile.calm { background: var(--calm-bg); color: var(--calm); }
  .tile.stress { background: var(--stress-bg); color: var(--stress); }
  .tile.calm::before { background: var(--calm); }
  .tile.stress::before { background: var(--stress); }
  .tile-k { font-family: var(--sans-cond); font-size: 10.5px;
            letter-spacing: .1em; text-transform: uppercase; color: var(--ink-faint); }
  .tile.mark .tile-k { color: inherit; opacity: .8; }
  .tile-v { font-family: var(--mono); font-size: 19px;
            font-weight: 500; font-variant-numeric: tabular-nums; line-height: 1.25; }
  .tile-s { font-family: var(--sans-cond); font-size: 10px; letter-spacing: .07em;
            text-transform: uppercase; color: var(--ink-faint); min-height: 14px; }
  .tile.mark .tile-s { color: inherit; opacity: .85; }
  .tile-d { font-family: var(--mono); font-size: 10px; color: var(--ink-faint);
            min-height: 14px; }
  .tile.mark .tile-d { color: inherit; opacity: .75; }
  .market-err { grid-column: 1 / -1; background: var(--surface); padding: 11px 14px;
                font-size: 13px; border-left: 3px solid var(--warn); }

  .panel { background: var(--surface); border: 1px solid var(--rule); border-radius: 6px;
           padding: 20px 22px; margin-top: 22px; box-shadow: var(--shadow); }
  .panel h2 { font-family: var(--sans-cond); font-size: 11px;
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
  /* ---------------------------------------------------------------------
     MARKET HISTORY. A collapsible strip of four charts between the tiles and
     the table. Closed by default - see the component header.

     The four are NOT equal height, on purpose. VIX is the one with a norm, so
     it gets the room to show a band being crossed; the regime strip is a
     colour bar and needs almost none. Equal heights would say the four
     matter equally, which they do not.
     --------------------------------------------------------------------- */
  .mh { margin-top: 20px; }
  .mh-head { display: flex; align-items: baseline; gap: 10px; width: 100%; padding: 8px 12px;
             border: 1px solid var(--rule); border-radius: 4px; background: var(--surface);
             font: inherit; color: inherit; text-align: left; cursor: pointer; }
  .mh-head:hover { background: var(--rule-soft); }
  .mh-t { font-family: var(--sans-cond); font-size: 11px; font-weight: 600;
          letter-spacing: .1em; text-transform: uppercase; color: var(--ink-soft); }
  .mh-span { font-family: var(--mono); font-size: 11px; color: var(--ink-faint); }
  .mh-asof { font-family: var(--mono); font-size: 11px; color: var(--warn);
             margin-left: auto; }
  .mh-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; margin-top: 1px;
             background: var(--rule); border: 1px solid var(--rule); border-radius: 4px;
             overflow: hidden; }
  /* VIX and its regime strip stack in the left column and read as one unit, which is why the
     strip sits directly beneath the chart it describes rather than beside it. */
  .mh-fig { background: var(--surface); padding: 10px 12px 6px; margin: 0; min-width: 0; }
  .mh-fig.mh-vix { grid-column: 1; grid-row: 1; }
  .mh-fig.mh-regime { grid-column: 1; grid-row: 2; }
  .mh-fig.mh-term { grid-column: 2; grid-row: 1; }
  .mh-fig.mh-breadth { grid-column: 2; grid-row: 2; }
  .mh-fig figcaption { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 10px;
                       margin-bottom: 6px; }
  .mh-ft { font-family: var(--sans-cond); font-size: 11px; font-weight: 600;
           letter-spacing: .08em; text-transform: uppercase; }
  .mh-fb { font-family: var(--mono); font-size: 10px; color: var(--ink-faint); }
  .mh-fs { font-size: 11.5px; color: var(--ink-faint); flex-basis: 100%; }
  /* The canvas box. min-width:0 on the figure and here is what stops a canvas from refusing to
     shrink inside a grid column - without it the panel widens the page instead of the chart
     narrowing, which is the one thing this layout may not do. */
  /* The band overlay sits INSIDE this box, behind the chart, so the box has to be a positioning
     context. The chart's own background is transparent, which is what lets the tints show. */
  .mh-canvas { width: 100%; min-width: 0; position: relative; }
  .mh-plot { position: relative; z-index: 1; width: 100%; height: 100%; }
  .mh-bands { position: absolute; left: 0; top: 0; bottom: 0; z-index: 0; pointer-events: none; }
  /* THE TINT IS A PSEUDO-ELEMENT, NOT AN OPACITY ON THE BAND, and the difference is not stylistic:
     the opacity property applies to the whole subtree and cannot be undone by a child, so a band
     at .085 with
     a label inside it has a label at .085 - invisible. The fill gets its own layer; the label
     stays opaque. */
  .mh-band { position: absolute; left: 0; right: 0; }
  .mh-band::before { content: ""; position: absolute; inset: 0; background: var(--band-ink);
                     opacity: .085; }
  /* The label is ink, not the band's hue. Three of the five ramp colours are pale enough that a
     9px uppercase word in them would fail the contrast floor, and the hue is already carried by
     the fill behind it and the swatch in the legend - it does not need saying a third time. */
  .mh-band-l { position: absolute; left: 4px; top: 1px; font-family: var(--sans-cond);
               font-size: 9px; letter-spacing: .1em; text-transform: uppercase;
               color: var(--ink-faint); }

  /* THE REGIME RAMP, one class per band, for the legend swatches and the VIX band tints.
     CARRIED ON A CUSTOM PROPERTY, NOT ON the color property, and that is a correctness point
     style one. These five are FILLS: a 9x9px swatch and a tint at 8.5% behind a chart. None of
     them is ever ink. Declaring them as color told check_contrast.sh they were text and it
     correctly failed three of them against the 4.5:1 floor for text - a floor that is simply the
     wrong question for a fill. Weakening the floor to make them pass would have weakened it for
     every real piece of text on the page; saying what they actually are costs nothing and leaves
     the check as strict as it was. */
  .r-calm    { --band-ink: var(--reg-calm); }
  .r-normal  { --band-ink: var(--reg-normal); }
  .r-high    { --band-ink: var(--reg-high); }
  .r-stress  { --band-ink: var(--reg-stress); }
  .r-extreme { --band-ink: var(--reg-extreme); }
  .r-unknown { --band-ink: var(--ink-faint); }

  /* Eight readings of the window. A definition list, because that is what it is. */
  .mh-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));
              gap: 1px; background: var(--rule-soft); border: 1px solid var(--rule-soft);
              margin: 12px 0 0; }
  .mh-stat { background: var(--surface); padding: 7px 10px; min-width: 0; }
  .mh-stat dt { font-family: var(--sans-cond); font-size: 9.5px; letter-spacing: .08em;
                text-transform: uppercase; color: var(--ink-faint); }
  .mh-stat dd { margin: 2px 0 0; font-family: var(--mono); font-size: 14px; color: var(--ink);
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mh-stat-n { margin-left: 5px; font-size: 10px; color: var(--ink-faint); }
  @media (max-width: 900px) { .mh-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } }

  /* The legend names only the bands that occurred - see regimesPresent. */
  .mh-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-bottom: 6px; }
  .mh-leg { display: inline-flex; align-items: baseline; gap: 5px; font-size: 12px;
            color: var(--ink-soft); }
  .mh-leg b { font-family: var(--mono); font-weight: 600; color: var(--ink); }
  .mh-leg-r { font-family: var(--mono); font-size: 10.5px; color: var(--ink-faint); }
  .mh-swatch { width: 9px; height: 9px; background: var(--band-ink); align-self: center;
               flex: 0 0 auto; }
  /* Reserved space before the palette has been read, so opening the panel does not jump. */
  .mh-hold { width: 100%; }
  .mh-err, .mh-note { margin-top: 10px; }
  .mh-note { font-size: 12.5px; color: var(--ink-faint); }

  /* The history chart inside the cell detail sheet. Fixed height, because the sheet is a modal
     and a chart that grows with its data would move the close button. */
  .hist-canvas { width: 100%; min-width: 0; height: 150px; margin-top: 4px; }
  .hist-hold { width: 100%; height: 150px; }
  .hist-note { margin-top: 6px; font-size: 12px; color: var(--ink-faint); }

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
             font-family: var(--sans-cond); font-weight: 600; font-size: 11px;
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

  /* THE GROUP RAILS. A 3px coloured rule along the top of each category heading, drawn as an inset
     shadow rather than a border-top so it does not add to the 26px the label row's sticky offset is
     written against - that literal and this height must not be able to disagree.

     ONE RULE PER GROUP KEY, and the keys come from GROUPS in lib/columns.ts, where the heading cell
     is rendered with className={g.key}. A group added there with no rail here gets no rail and
     nothing complains, which is the shape of defect this project has now shipped three times, so
     scripts/ci/check_contrast.sh enumerates GROUPS and fails on a key with no rule. */
  thead tr.grp th.price      { box-shadow: inset 0 3px 0 var(--g-price); }
  /* The two technicals bands are two depths of ONE hue, on purpose: they are the same kind of
     reading at two timeframes, and a reader who learns that slate means "where the price sits
     against an average" should not have to learn it twice. Every other band is its own hue
     because every other band is its own kind of question. */
  thead tr.grp th.techdaily  { box-shadow: inset 0 3px 0 var(--g-techdaily); }
  thead tr.grp th.techweekly { box-shadow: inset 0 3px 0 var(--g-techweekly); }
  thead tr.grp th.ma         { box-shadow: inset 0 3px 0 var(--g-ma); }
  thead tr.grp th.relative   { box-shadow: inset 0 3px 0 var(--g-relative); }
  thead tr.grp th.revenue    { box-shadow: inset 0 3px 0 var(--g-revenue); }
  thead tr.grp th.profit     { box-shadow: inset 0 3px 0 var(--g-profit); }
  thead tr.grp th.valuation  { box-shadow: inset 0 3px 0 var(--g-valuation); }
  thead tr.grp th.quality    { box-shadow: inset 0 3px 0 var(--g-quality); }
  thead tr.grp th.forward    { box-shadow: inset 0 3px 0 var(--g-forward); }

  /* The daily/weekly divider. One rule, full height, so the eye can tell at a glance which side of
     it a number lives on - "vs 21 EMA" appears on both and means different things. */
  thead th.grp-start, tbody td.grp-start { border-left: 1.5px solid var(--rule); }
  /* The as-of line under the RS heading. Same slot as a norm, distinguished by weight rather than
     colour so it does not read as a warning: RS being a session behind is the normal evening state,
     not a fault. */
  thead th .norm.asof { font-style: italic; }
  thead th .norm { display: block; font-family: var(--mono); font-size: 9.5px;
                   letter-spacing: 0; text-transform: none; color: var(--ink-faint);
                   font-weight: 400; margin-top: 2px; }

  tbody td { padding: 7px 12px; font-family: var(--mono);
             font-size: 13px; text-align: right; border-bottom: 1px solid var(--rule-soft);
             white-space: nowrap; }
  tbody td.sym { position: sticky; left: 0; background: var(--surface); text-align: left;
                 font-weight: 600; font-size: 13.5px; z-index: 2; }
  tbody td.sym .co { display: block; font-family: var(--sans); font-weight: 400;
                     font-size: 11px; color: var(--ink-faint); }
  tbody tr:hover td, tbody tr:hover td.sym { background: var(--rule-soft); }

  tr.band td { background: var(--paper); padding: 9px 12px 7px;
               font-family: var(--sans-cond); font-size: 11px; font-weight: 600;
               letter-spacing: .1em; text-transform: uppercase; color: var(--ink-soft);
               text-align: left; border-top: 1px solid var(--rule);
               border-bottom: 1px solid var(--rule); }
  tr.band td .n { font-family: var(--mono); color: var(--ink-faint);
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
  .warm { color: var(--ink-faint); margin-left: 2px; }

  .foot { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
          gap: 22px 34px; margin-top: 30px; }
  .foot h2 { font-family: var(--sans-cond); font-size: 11px;
             letter-spacing: .1em; text-transform: uppercase; color: var(--ink-faint);
             margin: 0 0 8px; font-weight: 600; }
  .foot p { margin: 8px 0 0; font-size: 13px; color: var(--ink-soft); }
  .key { display: flex; align-items: center; gap: 8px; font-size: 13px; margin-bottom: 6px; }
  .chip { display: inline-block; padding: 1px 7px; border-radius: 2px; font-size: 11.5px;
          font-family: var(--mono); font-weight: 500; border-left: 2.5px solid; }
  .chip.b { color: var(--below); background: var(--below-bg); border-color: var(--below); }
  .chip.a { color: var(--above); background: var(--above-bg); border-color: var(--above); }
  .chip.n { color: var(--ink-faint); background: transparent; border-color: var(--rule); }
  dl { margin: 0; font-size: 12.5px; }
  dl div { display: flex; justify-content: space-between; gap: 14px; padding: 3px 0;
           border-bottom: 1px solid var(--rule-soft); }
  dt { color: var(--ink-soft); }
  dd { margin: 0; font-family: var(--mono); color: var(--ink); }

  .note { margin-top: 26px; padding-top: 16px; border-top: 1px solid var(--rule);
          font-size: 12.5px; color: var(--ink-faint); max-width: 78ch; }
  code { font-family: var(--mono); font-size: 12.5px; }
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
  .brand { font-family: var(--serif); font-weight: 600; font-size: 17px;
           letter-spacing: 0; }

  /* ---------------------------------------------------------------------
     THE TABS FLOAT AT BOTTOM CENTRE, which is the spec's arrangement and not
     a cosmetic move. The top bar is where the page identifies itself and the
     table pins its two header rows; putting navigation there too meant three
     competing sticky things in the top 74px of a page whose entire purpose is
     vertical density. At the bottom the pill is in reach and out of the way.

     FIXED, not sticky: it must not move when the table scrolls, and both
     pages scroll their own containers rather than the body, so a sticky
     element here would have nothing to stick to.

     The blur is what lets it sit over a scrolling table without a box that
     hides rows. Backdrop-filter is progressive - where it is unsupported the
     translucent surface colour underneath still reads, which is why the
     background is a colour-mix rather than transparent.
     --------------------------------------------------------------------- */
  .tabs { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
          z-index: 30; display: flex; gap: 3px; padding: 4px;
          background: color-mix(in srgb, var(--surface) 88%, transparent);
          -webkit-backdrop-filter: blur(9px); backdrop-filter: blur(9px);
          border: 1px solid var(--rule); border-radius: 999px; box-shadow: var(--shadow); }
  .tab { display: flex; align-items: center; gap: 7px; height: 34px; padding: 0 16px;
         font-family: var(--sans-cond); font-size: 12px; font-weight: 600;
         letter-spacing: .06em; text-transform: uppercase; color: var(--ink-faint);
         text-decoration: none; border-radius: 999px; }
  .tab:hover { color: var(--ink); background: var(--rule-soft); }
  /* The active tab is a filled lozenge. In a pill of two there is no room for an understated
     underline to be unmistakable, which is what the old top-bar treatment relied on. */
  .tab.on { color: var(--paper); background: var(--ink); }
  .tab.on:hover { color: var(--paper); background: var(--ink); }
  .tabicon { font-size: 12px; opacity: .8; }

  /* THEME TOGGLE, top right. Three states in one control - see components/ThemeToggle.tsx for why
     it is three and not two: a two-state switch cannot express "follow the OS", which is what every
     first visit is and what this page did exclusively until today. */
  .themebtn { margin-left: auto; display: flex; align-items: center; gap: 7px;
              padding: 4px 10px; font-family: var(--sans-cond); font-size: 10.5px;
              font-weight: 600; letter-spacing: .1em; text-transform: uppercase;
              color: var(--ink-faint); background: transparent;
              border: 1px solid var(--rule); border-radius: 999px; cursor: pointer; }
  .themebtn:hover { color: var(--ink); border-color: var(--ink-faint); }
  .themebtn .ti { font-size: 12px; line-height: 1; }
  /* THE LABEL COMES FROM CSS, KEYED ON data-mode, and that is what keeps the button free of a
     hydration mismatch: the markup is identical on the server and the client, and the attribute the
     pre-paint script set decides what is painted. See components/ThemeToggle.tsx.
     The bare :root rules are the fallback for a first paint before the script runs, and for a
     viewer with JavaScript off - both of whom are on the system palette, which is what they say. */
  :root .themebtn .ti::before { content: "\\25D0"; }
  :root .themebtn .tl::before { content: "System"; }
  :root[data-mode="light"] .themebtn .ti::before { content: "\\25CB"; }
  :root[data-mode="light"] .themebtn .tl::before { content: "Light"; }
  :root[data-mode="dark"] .themebtn .ti::before { content: "\\25CF"; }
  :root[data-mode="dark"] .themebtn .tl::before { content: "Dark"; }

  /* Room for the floating pill. The bottom padding is the pill's height plus its inset plus a
     breath, so the last row of the table is readable rather than half under it. */
  main { padding-block: 24px 96px; }

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
  .seg { padding: 5px 12px; font-family: var(--mono); font-size: 12px;
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
  thead tr.grp th .asof { display: block; font-family: var(--mono);
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
  /* WARM-UP IS A PATTERN, NOT A COLOUR (the spec, 2026-09-20). The value exists and is shown; what
     is missing is the right to judge it, because the indicator has not seen enough bars yet. Ochre
     text said that in the same channel a verdict uses, so a warm-up cell read as a third verdict.
     A hatch says "provisional" in a channel nothing else on this page uses, and it survives
     greyscale and every form of colour blindness, which is the argument the eight-state model was
     built on. The asterisk stays as the textual carrier and loses its colour. */
  td.st-warmup { color: var(--ink); background-image: repeating-linear-gradient(
    -45deg, transparent 0 3px, var(--rule-soft) 3px 5px); }
  .dash { color: var(--ink-faint); }
  .unit { font-size: 10px; color: var(--ink-faint); margin-left: 1px; }

  /* Not-applicable is the only per-ROW marker left in a cell: an outline, never a fill, because we
     are declining to ask the question rather than reporting an answer.

     There is no .tag.plan any more. Planned is a statement about the COLUMN, so it is made once in
     the column heading (thead th .norm.plan, above) rather than 312 times on the Value preset,
     which is what it came to on screen. Bodhi, 2026-09-18. */
  .tag { font-family: var(--sans-cond); font-size: 9px; letter-spacing: .08em;
         text-transform: uppercase; padding: 1px 5px; border-radius: 2px; }
  .tag.na { color: var(--ink-faint); background: transparent; border: 1px dashed var(--rule); }
  /* The word "planned" where the footnote quotes a column heading, so the sentence points at
     something the reader can actually find on the screen above it. */
  .planword { color: var(--plan); font-family: var(--sans-cond);
              font-size: 11px; letter-spacing: .06em; text-transform: uppercase; }
  /* No norm: a tracked value with no threshold. Outlined rather than tinted - we have no opinion. */
  td.st-no-norm .cellbtn { text-decoration: underline; text-decoration-style: dotted;
                           text-decoration-color: var(--rule); text-underline-offset: 4px; }

  /* Categorical chips: label and number are one fact, so they sit together. */
  .chip { font-family: var(--sans-cond); font-size: 10.5px;
          letter-spacing: .04em; padding: 1px 6px; border-radius: 9px; background: var(--rule-soft);
          color: var(--ink-soft); }
  td.st-above .chip { background: var(--above-bg); color: var(--above); }
  td.st-below .chip { background: var(--below-bg); color: var(--below); }
  .chipnum { margin-left: 6px; font-size: 11.5px; color: var(--ink-faint); }

  /* THE EIGHT-QUARTER TRACE. Neutral ink, always — see components/Sparkline.tsx. The newest
     quarter is marked by WEIGHT, not by hue: full ink against seven muted bars. Colouring a
     falling series would make it a verdict, and the cell already carries a verdict of its own in
     its background, which the trace must not argue with. */
  .spark { display: inline-block; vertical-align: -3px; overflow: visible; }
  .spark-b { fill: var(--ink-faint); }
  .spark-b.last { fill: var(--ink); }
  .spark-zero { stroke: var(--rule); stroke-width: 1; }
  /* Inside a judged cell the trace picks up that cell's colour, so a red cell does not contain a
     grey chart floating on top of it. The verdict is still the cell's, not the trace's. */
  td.st-below .spark-b, td.st-above .spark-b,
  .dd-sec .st-below .spark-b, .dd-sec .st-above .spark-b { fill: currentColor; opacity: .45; }
  td.st-below .spark-b.last, td.st-above .spark-b.last,
  .dd-sec .st-below .spark-b.last, .dd-sec .st-above .spark-b.last { opacity: 1; }

  /* RANK IS A FRACTION, NOT A NUMBER. "5" alone is not a fact — fifth of six is a different
     statement from fifth of forty. The denominator is set smaller and faint so the rank still
     reads first. */
  .rank-n { font-weight: 600; }
  .rank-of { color: var(--ink-faint); font-size: 11px; margin-left: 1px; }

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
  .sheet h3 { margin: 0; font-family: var(--sans-cond); font-size: 18px; }
  .sheet .muted { margin: 2px 0 0; font-size: 12.5px; }
  .x { border: 0; background: none; font-size: 22px; line-height: 1; color: var(--ink-faint);
       cursor: pointer; padding: 0 2px; }
  .sheetstats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; margin-top: 16px;
                background: var(--rule); border: 1px solid var(--rule); border-radius: 5px;
                overflow: hidden; }
  .sheetstats > div { background: var(--surface); padding: 9px 12px; display: flex;
                      flex-direction: column; gap: 2px; }
  .sheetstats .k { font-family: var(--sans-cond); font-size: 9.5px;
                   letter-spacing: .1em; text-transform: uppercase; color: var(--ink-faint); }
  .sheetstats .v { font-family: var(--mono); font-size: 14px; }
  .why { margin: 14px 0 0; font-size: 13px; }
  .sheet .note { margin-top: 14px; padding-top: 12px; font-size: 12px; }

  .plan { margin: 0; padding-left: 18px; font-size: 13.5px; }
  .plan li { margin-bottom: 5px; }
  .plan em { color: var(--ink-faint); font-size: 12.5px; }

  /* ---------------------------------------------------------------------
     THE DEEP DIVE STRIP. One 420px analysis column per stock, scrolled
     sideways. The width is a constant, not a range: the whole point is that
     the RSI gauges sit at the same offset on every name so the eye can
     travel horizontally and compare one thing. It NEVER reflows into a
     vertical stack, at any width - on a phone it swipes.

     TWO-AXIS SCROLLING INSIDE ITS OWN FRAME, and that is what makes the
     per-column heading stick. A container with overflow-x:auto and
     overflow-y:visible has the y axis computed to auto, so a sticky child
     sticks to a box that never scrolls - which is to say, never. Giving the
     scroller a max-height gives the sticky heading something to stick to,
     and 53 columns of 8 sections is far taller than a screen, so knowing
     which name you are reading is not optional.
     --------------------------------------------------------------------- */
  .dd-wrap { position: relative; }
  .dd-wrap .dd-fade { position: absolute; top: 1px; bottom: 1px; width: 44px; pointer-events: none;
                      opacity: 0; transition: opacity .12s ease; z-index: 6; }
  /* A DARKENING, NOT A FADE TO THE SURFACE COLOUR. The grid learned this on 2026-09-18: a gradient
     to --surface over content erases the text beneath it instead of suggesting more content. */
  .dd-wrap .dd-fade.r { right: 1px; border-top-right-radius: 4px; border-bottom-right-radius: 4px;
                        background: linear-gradient(to left, var(--scrim), transparent); }
  .dd-wrap.more-r .dd-fade.r { opacity: 1; }

  .dd-scroll { margin-top: 22px; overflow: auto; max-height: min(84vh, 1000px);
               border: 1px solid var(--rule); border-radius: 4px; background: var(--surface);
               box-shadow: var(--shadow); overscroll-behavior-x: contain; }
  .dd-strip { display: flex; align-items: stretch; width: max-content; }
  .dd-col { box-sizing: border-box; border-right: 1px solid var(--rule-soft); }
  .dd-col:last-child { border-right: 0; }
  /* Where a theme changes. The grid bands its rows; the strip rules between blocks, which is the
     same statement rotated 90 degrees. */
  .dd-col.theme-start { border-left: 1.5px solid var(--rule); }

  .dd-head { position: sticky; top: 0; z-index: 4; background: var(--surface);
             padding: 11px 14px 9px; border-bottom: 1.5px solid var(--rule); }
  .dd-sym { font-family: var(--mono); font-size: 15px;
            font-weight: 600; display: flex; align-items: baseline; gap: 5px; }
  .dd-name { font-size: 11.5px; color: var(--ink-faint); margin-top: 1px;
             overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dd-theme { font-family: var(--sans-cond); font-size: 9.5px;
              letter-spacing: .1em; text-transform: uppercase; color: var(--ink-faint);
              margin-top: 3px; }
  .dd-behind { font-family: var(--mono); font-size: 10px; color: var(--warn);
               margin-top: 3px; }
  .tag.fund { color: var(--ink-faint); background: var(--rule-soft); border: 1px solid var(--rule);
              vertical-align: 2px; }

  .dd-sec { padding: 11px 14px 13px; border-bottom: 1px solid var(--rule-soft); }
  .dd-sec:last-child { border-bottom: 0; }
  .dd-sec h3 { margin: 0; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
               font-family: var(--sans-cond); font-size: 11px;
               font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
  /* THREE OUTCOMES, THREE TREATMENTS, keyed on what the panel RENDERS rather than on its params'
     statuses - see StockStrip's Section for the contradiction that produced ("planned" over
     "permanent, not pending" on an ETF). A panel showing data gets the full heading; one carrying a
     sentence is quieter, because the sentence is the content and the heading is only a label.
     Each needs a rule of its own: scripts/ci/check_strip_sections.sh fails the build if a render
     outcome has no CSS that can reach it. */
  .dd-sec.ss-data h3 { color: var(--ink-soft); }
  .dd-sec.ss-blocked h3 { color: var(--ink-faint); }
  .dd-sec.ss-na h3 { color: var(--ink-faint); }
  /* The n-a marker in a heading sits on the baseline of an uppercase label, so it needs the same
     nudge the ETF tag gets in the column header. */
  .dd-sec h3 .tag.na { vertical-align: 1px; }
  .dd-sec h3 .asof { font-family: var(--mono); font-size: 9px; font-style: italic;
                     letter-spacing: 0; text-transform: none; color: var(--ink-faint); }
  /* Explicit, and NOT inheriting the bare .plan rule above: that one is a list style, and at
     specificity 0,1,0 its padding-left would indent this marker by 18px. */
  .dd-sec h3 .norm { font-family: var(--mono); font-size: 9.5px; padding: 0;
                     letter-spacing: 0; text-transform: none; font-weight: 400; }
  .dd-sec h3 .norm.plan { color: var(--plan); letter-spacing: .06em; }
  /* NO .dd-sub RULE. The section's one-line description is the heading's title attribute now, not
     an element - it is identical on every column, and this layout multiplies anything constant by
     the size of the watchlist. Removed with its markup rather than left behind: a rule matching
     nothing is how a stylesheet starts describing a page that no longer exists. */

  /* The sentence a blocked section carries. Tinted with --plan, the same colour the grid uses for
     a planned column heading, so "not built" looks the same in both halves of the product. */
  .dd-why { margin: 7px 0 0; padding: 6px 9px; font-size: 11.5px; line-height: 1.45;
            color: var(--ink-soft); background: var(--paper); border-radius: 3px;
            border-left: 2.5px solid var(--plan); }
  /* NOT APPLICABLE is a different sentence from NOT BUILT, so it gets a different edge: dashed and
     neutral, matching the .tag.na treatment in the grid, because we are declining to ask the
     question rather than queueing it. An ETF's Fundamentals panel is this, permanently. */
  .dd-why.na { border-left: 2.5px dashed var(--rule); color: var(--ink-faint); }
  /* NO .dd-partial RULE. The line it styled said the same thing on every column - a fact about a
     parameter, not about a security - so it is now in the page footnote, once. Deleted with its
     markup: a rule for markup that no longer exists is how a stylesheet starts lying. */

  /* NO RESERVED CHART BOX HERE, and the first version had one. A dashed 200px placeholder under the
     sentence reserved space for something that is not coming in this release, at 200px multiplied
     by 53 columns, and it never rendered anyway: a blocked section shows its sentence and returns,
     so both the component and this rule were dead. Measuring the rendered page is what found it.
     The sentence IS the content. */

  /* ---- The price panel -----------------------------------------------
     The only section that fetches. It reads its bars when the column is
     scrolled to, so what sits here before that is a sentence, never a frame
     with axes in it - an empty chart is a claim about the data, and the
     claim would be false.

     THE CHART IS LOCKED, like every other chart in this app, and the range
     buttons are the control. An earlier build let it be dragged; two
     measurements ended that. Panning moves the window without widening it,
     so the line mark could never be reached however far you dragged - and a
     drag inside a horizontally scrolling strip is ambiguous about whether
     it moves the chart or the strip. See RANGES in lib/stock-history.ts. */
  .pc { margin-top: 9px; }
  .pc-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  /* The legend takes whatever is left and wraps to its own line if the two controls need the room,
     rather than squeezing a button to nothing at a narrower column. */
  .pc-legend { margin-left: auto; }
  /* Two segmented controls, same treatment: WHAT is plotted (D/W) and HOW MUCH (3M/1Y/5Y). They
     are separate groups rather than one row of five, because they answer different questions and a
     single row would invite reading 3M as a third timeframe. */
  .pc-tf, .pc-range { display: inline-flex; border: 1px solid var(--rule); border-radius: 3px;
                      overflow: hidden; }
  .pc-tf .seg, .pc-range .seg { padding: 1px 7px; font-family: var(--mono);
                font-size: 10px; letter-spacing: .06em; border: 0;
                border-right: 1px solid var(--rule); background: none; color: var(--ink-faint);
                cursor: pointer; }
  .pc-tf .seg:last-child, .pc-range .seg:last-child { border-right: 0; }
  .pc-tf .seg.on, .pc-range .seg.on { background: var(--ink); color: var(--surface); }
  /* The legend is three words, and each carries the colour its line is drawn in - so the overlay
     order cannot silently disagree with the chart. The three tokens are the same ones the chart
     reads through lib/chart-theme.ts, which is what keeps them equal in both themes. */
  .pc-legend { display: inline-flex; gap: 9px; font-family: var(--mono);
               font-size: 9px; letter-spacing: .04em; }
  /* The legend keys carry the OVERLAY tokens, not the verdict ones, and must stay in the same order
     as the colours array in components/StockChart.tsx - the legend is a claim about what is drawn on
     the canvas beside it, and a mismatch here is a chart that lies quietly. */
  .pc-key.k0 { color: var(--ma1); }
  .pc-key.k1 { color: var(--ma2); }
  .pc-key.k2 { color: var(--ma3); }
  /* An overlay this listing has too little history for. Struck rather than hidden, so the reader
     sees that the line is absent and not that the legend forgot it. ALAB, ARM and SNDK have fewer
     than 200 completed weeks, which is a fact about the listing and not a gap in the data. */
  .pc-key.off { color: var(--ink-faint); text-decoration: line-through;
                text-decoration-thickness: 1px; opacity: .75; }
  .pc-canvas { width: 100%; min-width: 0; margin-top: 5px; }
  .pc-hold { width: 100%; }
  /* TWO LINES, ALWAYS, whether the caption needs them or not.
     The caption is the only thing in a column whose length changes with a click: 5Y says more than
     3M, and the weekly view adds a clause. At one line it wrapped on the long ones, which pushed
     that column's RSI panel 17px below every other column's - and sections lining up across names
     is the entire premise of the strip. A reserved height costs 14px on every column once; a wrap
     costs the comparison the layout exists for. Caught in a screenshot, not by an assertion, which
     is why the harness now measures column heights AFTER interacting rather than only on load. */
  .pc-note { margin-top: 5px; padding-top: 0; border-top: 0; font-size: 10.5px; max-width: none;
             min-height: 31px; }

  /* ---- RSI gauges -----------------------------------------------------
     Bars on a 0-100 track, not dials. RSI is bounded by construction, so the
     track is the whole domain; the band is drawn as two dashed threshold
     edges, which is exactly how the VIX chart draws its norm, so the two
     read as the same kind of statement. The band geometry comes from the
     norm and never from a literal 30/70 - rsi_weekly is 40/70 today. */
  .dd-gauges { margin-top: 9px; display: grid; gap: 8px; }
  .dd-gauge { display: grid; grid-template-columns: 14px 1fr 48px 44px; align-items: center;
              gap: 9px; font-family: var(--mono); font-size: 12px;
              font-variant-numeric: tabular-nums; }
  .g-tf { font-size: 8.5px; letter-spacing: .08em; color: var(--ink-faint); text-align: center; }
  .g-track { position: relative; height: 7px; background: var(--rule-soft); border-radius: 2px; }
  .g-band { position: absolute; top: -2px; bottom: -2px; box-sizing: border-box;
            border-left: 1px dashed var(--ink-faint); border-right: 1px dashed var(--ink-faint); }
  .g-mark { position: absolute; top: -3px; bottom: -3px; width: 3px; margin-left: -1.5px;
            border-radius: 1px; background: var(--ink); }
  .g-mark.st-below { background: var(--below); }
  .g-mark.st-above { background: var(--above); }
  .g-val { text-align: right; }
  .g-norm { font-size: 9.5px; color: var(--ink-faint); text-align: right; }
  /* A gauge whose param is not built keeps its band and loses its marker: the rule is set, the
     number is not computed. The track is dimmed so it does not read as a value of zero. */
  .dd-gauge.st-planned .g-track { opacity: .45; }

  /* ---- Relative-strength bars ----------------------------------------
     THE FILL IS NEUTRAL IN BOTH DIRECTIONS, and that is a hard constraint
     rather than a palette choice. Only rs_vs_spx_126b has a norm; colouring
     a bar green for "outperforming" would be inventing a verdict on the two
     that have none, which is the one thing this product does not do. The
     direction is carried by which side of zero the bar sits on, and the
     verdict - where there is one - by the number's own state colour. */
  .dd-bars { margin-top: 9px; display: grid; gap: 8px; }
  .dd-bar { display: grid; grid-template-columns: 38px 1fr 58px; align-items: center; gap: 9px;
            font-family: var(--mono); font-size: 12px;
            font-variant-numeric: tabular-nums; }
  .b-lab { font-size: 9.5px; letter-spacing: .04em; color: var(--ink-faint); }
  .b-track { position: relative; height: 8px; background: var(--rule-soft); border-radius: 2px; }
  .b-zero { position: absolute; left: 50%; top: -2px; bottom: -2px; width: 1px;
            background: var(--ink-faint); }
  .b-fill { position: absolute; top: 1px; bottom: 1px; background: var(--ink-soft); }
  .b-fill.pos { left: 50%; border-radius: 0 2px 2px 0; }
  .b-fill.neg { right: 50%; border-radius: 2px 0 0 2px; }
  /* The bar ran past its display bound. A solid cap at the outer end, so the glance says "further
     than this" while the number beside it stays the exact figure. */
  .b-fill.pos.clipped { border-right: 2.5px solid var(--ink); }
  .b-fill.neg.clipped { border-left: 2.5px solid var(--ink); }
  .b-val { text-align: right; }

  /* ---- Label / value rows -------------------------------------------- */
  .dd-rows { margin: 9px 0 0; font-size: 12px; }
  .dd-rows .dd-row { display: flex; align-items: baseline; justify-content: space-between;
                     gap: 12px; padding: 4px 0 4px 6px; border-bottom: 1px solid var(--rule-soft);
                     position: relative; }
  .dd-rows .dd-row:last-child { border-bottom: 0; }
  .dd-row dt { display: flex; align-items: baseline; gap: 5px; color: var(--ink-soft);
               min-width: 0; }
  .dd-row dd { margin: 0; font-family: var(--mono); white-space: nowrap;
               font-variant-numeric: tabular-nums; }
  .dd-row dt .norm { font-family: var(--mono); font-size: 9px; padding: 0;
                     color: var(--ink-faint); }
  /* Severity in form as well as colour, the same 2.5px rule the grid draws on a judged cell. */
  .dd-row.mark { font-weight: 600; }
  .dd-row.mark::before { content: ""; position: absolute; left: 0; top: 2px; bottom: 2px;
                         width: 2.5px; }
  .dd-row.st-below::before { background: var(--below); }
  .dd-row.st-above::before { background: var(--above); }

  /* ---- Cell states inside the strip ----------------------------------
     THESE ARE NOT THE GRID'S RULES. The grid styles td.st-below; a strip row
     is a div, so every one of those selectors matches nothing here. That is
     the exact defect shipped on 2026-09-18 - tbody td.below against a class
     that was really st-below - repeating in a new place, and it is invisible
     at every layer of the toolchain because CSS that matches nothing is not
     an error. scripts/ci/check_strip_sections.sh asserts that each cell
     state reachable in the strip has a rule under .dd-sec. */
  .dd-sec .st-below { color: var(--below); }
  .dd-sec .st-above { color: var(--above); }
  .dd-sec .st-normal { color: var(--ink); }
  /* The strip's warm-up carries the same hatch as the grid's - see td.st-warmup. Its own rule,
     because a strip row is a div and none of the grid's selectors reach it. */
  .dd-sec .st-warmup { color: var(--ink); background-image: repeating-linear-gradient(
    -45deg, transparent 0 3px, var(--rule-soft) 3px 5px); }
  .dd-sec .st-null, .dd-sec .st-planned, .dd-sec .st-no-norm { color: var(--ink-faint); }
  /* THERE IS NO .dd-sec .st-na RULE, deliberately, and that absence is checked. A section whose
     every param is inapplicable collapses to one sentence (see sectionRender), so no strip element
     can carry .st-na - a rule for it would be dead CSS, which is the 2026-09-18 defect inverted.
     check_strip_sections.sh fails BOTH ways: a reachable state with no rule, and a rule for a state
     that cannot occur. When Phase 4 makes the fundamentals live, that check is what will tell us
     whether this needs to come back. */
  /* No norm: tracked, not judged. Outlined rather than tinted - we have no opinion, and the dotted
     underline says so without borrowing a verdict colour. */
  .dd-row.st-no-norm dd { text-decoration: underline; text-decoration-style: dotted;
                          text-decoration-color: var(--rule); text-underline-offset: 3px; }
  .dd-sec .st-above .chip { background: var(--above-bg); color: var(--above); }
  .dd-sec .st-below .chip { background: var(--below-bg); color: var(--below); }

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

/**
 * The pre-paint theme script.
 *
 * RUNS BEFORE FIRST PAINT, which is the only place this can be done. Read the stored mode, set the
 * two attributes the stylesheet and the toggle's label key off, and get out of the way. If it ran
 * from an effect instead, a viewer who chose dark would see one painted frame of cream paper on
 * every navigation — the flash is not a nicety, it is the whole reason the script exists.
 *
 * It duplicates the mapping in `components/ThemeToggle.tsx` (applyMode) because it cannot import it:
 * this text is inlined into the document head and runs before any bundle. The duplication is four
 * lines and is the reason the export is documented as shared.
 *
 * Kept as a plain double-quoted string. NO BACKTICKS and no template interpolation — the same
 * hazard as the CSS above, in a place where the error would be a silent no-op instead of a build
 * failure, because a script that throws leaves the attributes unset and the page merely follows the
 * OS. The catch does exactly that on purpose.
 */
const THEME_SCRIPT =
  '(function(){var e=document.documentElement;try{var m=localStorage.getItem("swing-theme");' +
  'if(m!=="light"&&m!=="dark")m="system";e.setAttribute("data-mode",m);' +
  'if(m==="system"){e.removeAttribute("data-theme")}else{e.setAttribute("data-theme",m)}}' +
  'catch(x){e.setAttribute("data-mode","system")}})();';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning because THEME_SCRIPT writes data-mode and data-theme onto this
    // element before React hydrates. The attributes are deliberately not in the server markup —
    // the server does not know the viewer's choice, and guessing would be the flash again.
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* Spectral is the serif for titles; the two Plex families are the interface and its
            condensed labels. Numbers use the platform monospace, which needs no download. */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Condensed:wght@600;700&family=IBM+Plex+Sans:wght@400;500;600&family=Spectral:wght@400;600&display=swap"
        />
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        {/* The persistent application frame. Two tabs carry the entire product: Dashboard answers
            "what is happening across the universe", Deep Dive answers "what is happening inside
            these names". No third workflow competes with those two.

            THE TABS ARE RENDERED HERE BUT DRAWN AT THE BOTTOM of the viewport — .tabs is fixed, see
            the stylesheet. They stay inside the header element so the document order still reads
            brand, navigation, theme, content, which is the order a keyboard and a screen reader
            walk; only the painting moved. */}
        <header className="frame">
          <span className="brand">Swing Tracker</span>
          <Tabs />
          <ThemeToggle />
        </header>
        {children}
      </body>
    </html>
  );
}
