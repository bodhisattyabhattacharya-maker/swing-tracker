/**
 * columns.ts — the column catalogue, the presets, and the cell-state model.
 *
 * PURE ON PURPOSE, AND THAT IS THE WHOLE REASON THIS FILE EXISTS SEPARATELY FROM `grid.ts`.
 *
 * `lib/grid.ts` holds the service_role key and must never be imported by a client component; its
 * header explains what that would cost in a public repo. But the interactive table genuinely needs
 * to run in the browser — presets, sorting, filtering, collapsing groups and opening a cell are all
 * things a server round-trip would make feel broken.
 *
 * So the data layer and the column catalogue are separate modules. This one has no fetch, no env
 * var and no secret: a client component imports THIS, gets its rows as props, and never has a path
 * to the key. `scripts/ci/check_web_boundary.sh` fails the build if a file containing "use client"
 * imports from `lib/grid.ts`, because a rule that lives only in a comment is not a rule.
 *
 * ---------------------------------------------------------------------------
 * WHAT A COLUMN KNOWS
 *
 * `source` says which view the value comes from. `status` says whether that view exists yet:
 * `live` columns read real data, `planned` ones render the Planned state and are still shown, with
 * their label and their group, exactly as the design asks. A planned column is NOT a blank — a
 * blank reads as "no value for this name", and these have no value for anyone yet.
 *
 * `applies` is the third state and the one that is easy to skip: a question that does not apply to
 * this security. An ETF has no P/E because it has no income statement; a `rankable: false` theme
 * has no sector rank because there is no peer group. Both must look different from missing data —
 * the spec is explicit that "not applicable is intentional".
 */

export type Timeframe = "daily" | "weekly" | "hourly" | "none";

/** Which view a value is read from. `signals` and `rs` are sibling cell views of `grid_cells`. */
export type Source = "cells" | "rs" | "signals" | "fundamentals" | "forward";

/** Whether the parameter exists in the database today. */
export type Status = "live" | "planned";

/**
 * How a value is rendered. Four kinds, and each carries its payload in a DIFFERENT field of
 * `CellLike` — see `cellState`, where getting that wrong would call a populated cell empty.
 *
 *   number     `value`             the ordinary case
 *   chip       `label` + `tone`    a categorical signal, optionally with a number beside it
 *   sparkline  `series`            eight quarters, oldest first
 *   rank       `value` + `peers`   a position inside a peer group, rendered as a fraction
 *
 * `rank` exists rather than reusing `number` because a bare "5" is not a fact: fifth of six and
 * fifth of forty are different statements, and the denominator has to travel with the rank. It
 * comes off the same window function that computes the rank, not counted separately in the page —
 * two sources for one fact is how they end up disagreeing.
 */
export type Render = "number" | "chip" | "sparkline" | "rank";

export interface Group {
  key: string;
  label: string;
}

/**
 * The category row of the two-tier header. **Order here is the order on screen**, for every preset
 * — `columnsFor` sorts by this and then by declaration order, so a preset cannot hold a second,
 * disagreeing order of its own.
 *
 * TEN BANDS SINCE 2026-09-20, from the visual spec (decision 0053). The standalone RSI band is
 * gone: RSI is a technical reading like the three vs-average columns beside it, and separating it
 * meant the daily and weekly readings of the same thing sat in different places while "vs 21 EMA"
 * appeared twice inside one eleven-column band. The split is now measurement (daily / weekly)
 * versus derived signal, which is also a clean split by render kind — every technicals column is a
 * number and every MA-signals column is a chip.
 */
export const GROUPS: Group[] = [
  { key: "price", label: "Price" },
  { key: "techdaily", label: "Technicals · daily" },
  { key: "techweekly", label: "Technicals · weekly" },
  { key: "ma", label: "MA signals" },
  { key: "relative", label: "Relative" },
  { key: "revenue", label: "Revenue" },
  { key: "profit", label: "Profit" },
  { key: "valuation", label: "Valuation" },
  { key: "quality", label: "Quality" },
  { key: "forward", label: "Forward look" },
];

export interface Column {
  /** Matches `param` in whichever cell view `source` names. A typo here is a permanently blank column. */
  param: string;
  label: string;
  group: string;
  timeframe: Timeframe;
  source: Source;
  status: Status;
  render: Render;
  digits: number;
  signed: boolean;
  /** Printed after the value, e.g. "%" or "×". Kept out of the header so the number reads whole. */
  suffix?: string;
  /** One line, shown in the cell detail sheet. The metric's meaning, not its formula. */
  hint?: string;
  /**
   * False when the question does not apply to this security. Absent means it applies to everything.
   * Not a filter — the row still renders, carrying the Not-applicable state.
   */
  applies?: (s: Security) => boolean;
}

export interface Security {
  symbol: string;
  is_fund: boolean;
  rankable: boolean;
}

/** A fund has no income statement, so every fundamental is a question it cannot be asked. */
const notFunds = (s: Security) => !s.is_fund;
/** A theme marked `rankable: false` has no peer group, so a percentile within it means nothing. */
const rankableOnly = (s: Security) => s.rankable && !s.is_fund;

// ---------------------------------------------------------------------------
// The catalogue. One entry per metric in the specification, live or not.
//
// ORDER WITHIN A GROUP IS THE ORDER ON SCREEN and follows the screenshots, which the spec says win
// over its own prose where the two differ.
// ---------------------------------------------------------------------------
export const COLUMNS: Column[] = [
  // ---- Price -------------------------------------------------------------
  { param: "close", label: "Close", group: "price", timeframe: "daily", source: "cells",
    status: "live", render: "number", digits: 2, signed: false,
    hint: "Split-adjusted close. Not dividend-adjusted — see DEFINITIONS §4a." },
  { param: "pct_off_52w_high", label: "Off 52w high", group: "price", timeframe: "daily",
    source: "cells", status: "live", render: "number", digits: 1, signed: true, suffix: "%",
    hint: "Against the highest intraday high in 252 trading bars." },
  { param: "pct_off_high_stored", label: "Off 5y high", group: "price", timeframe: "daily",
    source: "cells", status: "live", render: "number", digits: 1, signed: true, suffix: "%",
    hint: "Against the highest price we HOLD — five years, not all time. Several names peaked in 2000." },
  { param: "pct_above_low_stored", label: "Above 5y low", group: "price", timeframe: "daily",
    source: "cells", status: "live", render: "number", digits: 1, signed: true, suffix: "%",
    hint: "Recovery distance from the lowest intraday low in stored history." },
  { param: "realized_vol_20", label: "Real vol 20", group: "price", timeframe: "daily",
    source: "cells", status: "live", render: "number", digits: 1, signed: false, suffix: "%",
    hint: "Annualised sample stdev of 20 daily log returns." },
  { param: "volume_ratio", label: "Vol ratio", group: "price", timeframe: "daily", source: "cells",
    status: "live", render: "number", digits: 2, signed: false, suffix: "×",
    hint: "Today's volume over its own 50-day average, which includes today." },

  // ---- Technicals, daily -------------------------------------------------
  //
  // THE TWO TECHNICALS BANDS AND THE MA SIGNALS BAND WERE ONE BAND UNTIL 2026-09-20, and the split
  // is the spec's (decision 0053). It draws a real line: these columns are MEASUREMENTS — where
  // the price sits right now relative to something — while the MA signals band below holds
  // DERIVED STATEMENTS about the averages themselves, which is why every one of those renders as a
  // chip and every one of these as a number.
  //
  // Splitting by timeframe rather than keeping one technicals band matters because "vs 21 EMA"
  // appears on both sides and means different things. It had a [D] or [W] marker beside it and a
  // full-height rule somewhere in the middle of eleven columns; now the band heading says it.
  { param: "rsi_hourly", label: "RSI 14", group: "techdaily", timeframe: "hourly", source: "cells",
    status: "planned", render: "number", digits: 1, signed: false,
    hint: "Blocked on session-aligned hourly bars: the vendor's hours start on the clock, TradingView's on the 09:30 open, and the 30/70 threshold moves with the alignment." },
  { param: "rsi_daily", label: "RSI 14", group: "techdaily", timeframe: "daily", source: "cells",
    status: "live", render: "number", digits: 1, signed: false,
    hint: "Wilder's smoothing, not a simple average of gains and losses." },
  { param: "close_vs_ema21d", label: "vs 21 EMA", group: "techdaily", timeframe: "daily", source: "cells",
    status: "live", render: "number", digits: 1, signed: true, suffix: "%" },
  { param: "close_vs_sma50d", label: "vs 50 SMA", group: "techdaily", timeframe: "daily", source: "cells",
    status: "live", render: "number", digits: 1, signed: true, suffix: "%" },
  { param: "close_vs_sma200d", label: "vs 200 SMA", group: "techdaily", timeframe: "daily", source: "cells",
    status: "live", render: "number", digits: 1, signed: true, suffix: "%" },

  // ---- Technicals, weekly ------------------------------------------------
  { param: "rsi_weekly", label: "RSI 14", group: "techweekly", timeframe: "weekly", source: "cells",
    status: "live", render: "number", digits: 1, signed: false,
    hint: "On completed weekly bars. Constant Monday to Friday; it steps on the week boundary." },
  { param: "close_vs_ema21w", label: "vs 21 EMA", group: "techweekly", timeframe: "weekly", source: "cells",
    status: "live", render: "number", digits: 1, signed: true, suffix: "%" },
  { param: "close_vs_sma30w", label: "vs 30W SMA", group: "techweekly", timeframe: "weekly", source: "cells",
    status: "live", render: "number", digits: 1, signed: true, suffix: "%" },
  { param: "close_vs_sma200w", label: "vs 200W SMA", group: "techweekly", timeframe: "weekly",
    source: "cells", status: "live", render: "number", digits: 1, signed: true, suffix: "%",
    hint: "Uncoloured by design: 87–90% of name-weeks sit above +10 in every year we hold, so a band there flags nine rows in ten." },

  // ---- MA signals --------------------------------------------------------
  // What the averages are doing, as opposed to where the price sits against them. All five are
  // chips because all five are categorical or a rate, not a level.
  { param: "ma_stack", label: "MA stack", group: "ma", timeframe: "daily", source: "signals",
    status: "live", render: "chip", digits: 0, signed: false,
    hint: "Full bull is close > EMA21 > SMA50 > SMA200; Full bear is the exact reverse; everything else is Mixed." },
  { param: "cross_50_200", label: "50×200", group: "ma", timeframe: "daily", source: "signals",
    status: "live", render: "chip", digits: 0, signed: false,
    hint: "Golden or Death, with TRADING BARS since it happened. Blank means no cross in the five years we hold." },
  { param: "cross_21_50", label: "21×50", group: "ma", timeframe: "daily", source: "signals",
    status: "live", render: "chip", digits: 0, signed: false,
    hint: "Bull or Bear, with trading bars since. The faster pair — it turns over far more often than 50×200." },
  { param: "sma50_slope", label: "50 slope", group: "ma", timeframe: "daily", source: "signals",
    status: "live", render: "chip", digits: 2, signed: true, suffix: "%/wk",
    hint: "Change in the AVERAGE over five trading bars — the trend of the trend, not of price." },
  { param: "sma200_slope", label: "200 slope", group: "ma", timeframe: "daily", source: "signals",
    status: "live", render: "chip", digits: 2, signed: true, suffix: "%/wk" },

  // ---- Relative ----------------------------------------------------------
  { param: "rs_vs_spx_63b", label: "vs SPX 63b", group: "relative", timeframe: "daily", source: "rs",
    status: "live", render: "number", digits: 1, signed: true, suffix: "pp" },
  { param: "rs_vs_spx_126b", label: "vs SPX 126b", group: "relative", timeframe: "daily",
    source: "rs", status: "live", render: "number", digits: 1, signed: true, suffix: "pp",
    hint: "Percentage points of out- or under-performance over 126 TRADING BARS. Named for bars, not months." },
  { param: "rs_vs_spx_252b", label: "vs SPX 252b", group: "relative", timeframe: "daily",
    source: "rs", status: "live", render: "number", digits: 1, signed: true, suffix: "pp" },
  { param: "valuation_rank", label: "Valuation rank", group: "relative", timeframe: "none",
    source: "fundamentals", status: "planned", render: "rank", digits: 0, signed: false,
    applies: rankableOnly,
    hint: "Where its FCF yield sits inside its own theme. Blank for a theme that is not a peer group — that is not missing data." },
  { param: "margin_rank", label: "Margin rank", group: "relative", timeframe: "none",
    source: "fundamentals", status: "planned", render: "rank", digits: 0, signed: false,
    applies: rankableOnly,
    hint: "Same, on trailing gross margin. Separates executing well from riding a good cycle." },

  // ---- Revenue -----------------------------------------------------------
  { param: "rev_growth_yoy", label: "Revenue YoY", group: "revenue", timeframe: "none",
    source: "fundamentals", status: "planned", render: "number", digits: 1, signed: true,
    suffix: "%", applies: notFunds,
    hint: "Quarterly, year over year, AS REPORTED — restated figures would destroy the point-in-time property." },
  { param: "rev_cagr_3y", label: "Rev 3y CAGR", group: "revenue", timeframe: "none",
    source: "fundamentals", status: "planned", render: "number", digits: 1, signed: true,
    suffix: "%", applies: notFunds },
  { param: "rev_cagr_5y", label: "Rev 5y CAGR", group: "revenue", timeframe: "none",
    source: "fundamentals", status: "planned", render: "number", digits: 1, signed: true,
    suffix: "%", applies: notFunds },
  { param: "rev_qoq_last", label: "Rev QoQ last Q", group: "revenue", timeframe: "none",
    source: "fundamentals", status: "planned", render: "number", digits: 1, signed: true,
    suffix: "%", applies: notFunds },
  { param: "rev_spark_8q", label: "Revenue 8Q", group: "revenue", timeframe: "none",
    source: "fundamentals", status: "planned", render: "sparkline", digits: 0, signed: false,
    applies: notFunds,
    hint: "Eight quarters, scaled per security — the shape is the point, not the magnitude." },

  // ---- Profit ------------------------------------------------------------
  { param: "eps_growth_yoy", label: "EPS YoY", group: "profit", timeframe: "none",
    source: "fundamentals", status: "planned", render: "number", digits: 1, signed: true,
    suffix: "%", applies: notFunds },
  { param: "eps_cagr_3y", label: "EPS 3y CAGR", group: "profit", timeframe: "none",
    source: "fundamentals", status: "planned", render: "number", digits: 1, signed: true,
    suffix: "%", applies: notFunds },
  { param: "eps_cagr_5y", label: "EPS 5y CAGR", group: "profit", timeframe: "none",
    source: "fundamentals", status: "planned", render: "number", digits: 1, signed: true,
    suffix: "%", applies: notFunds },
  { param: "gross_margin_trend", label: "GM trend", group: "profit", timeframe: "none",
    source: "fundamentals", status: "planned", render: "number", digits: 1, signed: true,
    suffix: "pp", applies: notFunds },
  { param: "eps_spark_8q", label: "EPS 8Q", group: "profit", timeframe: "none",
    source: "fundamentals", status: "planned", render: "sparkline", digits: 0, signed: false,
    applies: notFunds },

  // ---- Valuation ---------------------------------------------------------
  { param: "pe_trailing", label: "P/E trailing", group: "valuation", timeframe: "none",
    source: "fundamentals", status: "planned", render: "number", digits: 2, signed: false,
    suffix: "×", applies: notFunds,
    hint: "GAAP, diluted, TTM. Null when TTM EPS is at or below zero — a negative P/E is not cheap, it is meaningless." },
  { param: "ps_ttm", label: "P/S TTM", group: "valuation", timeframe: "none",
    source: "fundamentals", status: "planned", render: "number", digits: 2, signed: false,
    suffix: "×", applies: notFunds },
  { param: "ev_sales", label: "EV/Sales", group: "valuation", timeframe: "none",
    source: "fundamentals", status: "planned", render: "number", digits: 2, signed: false,
    suffix: "×", applies: notFunds },
  { param: "ev_ebitda", label: "EV/EBITDA", group: "valuation", timeframe: "none",
    source: "fundamentals", status: "planned", render: "number", digits: 2, signed: false,
    suffix: "×", applies: notFunds },
  { param: "fcf_yield", label: "FCF yield", group: "valuation", timeframe: "none",
    source: "fundamentals", status: "planned", render: "number", digits: 1, signed: true,
    suffix: "%", applies: notFunds,
    hint: "(CFO − capex) over market cap. Levered numerator, levered denominator." },
  { param: "pb", label: "P/B", group: "valuation", timeframe: "none", source: "fundamentals",
    status: "planned", render: "number", digits: 2, signed: false, suffix: "×", applies: notFunds },

  // ---- Quality -----------------------------------------------------------
  { param: "roic", label: "ROIC", group: "quality", timeframe: "none", source: "fundamentals",
    status: "planned", render: "number", digits: 1, signed: true, suffix: "%", applies: notFunds,
    hint: "NOPAT over debt + equity − cash. Definition-sensitive; ours is stated in DEFINITIONS §7." },
  { param: "net_debt_ebitda", label: "Net debt/EBITDA", group: "quality", timeframe: "none",
    source: "fundamentals", status: "planned", render: "number", digits: 2, signed: true,
    suffix: "×", applies: notFunds,
    hint: "Operating leases counted as debt, here and in EV — decision 0040." },
  { param: "fcf_margin", label: "FCF margin", group: "quality", timeframe: "none",
    source: "fundamentals", status: "planned", render: "number", digits: 1, signed: true,
    suffix: "%", applies: notFunds },
  { param: "share_count_yoy", label: "Share count YoY", group: "quality", timeframe: "none",
    source: "fundamentals", status: "planned", render: "number", digits: 1, signed: true,
    suffix: "%", applies: notFunds,
    hint: "Cover-page shares, year over year. Negative is buyback, positive is dilution." },

  // ---- Forward look ------------------------------------------------------
  // Every one of these is a SEARCHED column: no source in the data plane carries analyst
  // consensus, at any tier. They are opinion rather than measurement, and the design gives them
  // their own tinted group header so they never read as facts beside the GAAP ones.
  { param: "fwd_revenue", label: "Fwd revenue", group: "forward", timeframe: "none",
    source: "forward", status: "planned", render: "number", digits: 2, signed: false,
    applies: notFunds, hint: "Next fiscal year consensus. Searched, not computed — carries its own source and as-of." },
  { param: "fwd_eps", label: "Fwd EPS", group: "forward", timeframe: "none", source: "forward",
    status: "planned", render: "number", digits: 2, signed: false, applies: notFunds },
  { param: "fwd_pe", label: "Fwd P/E", group: "forward", timeframe: "none", source: "forward",
    status: "planned", render: "number", digits: 2, signed: false, suffix: "×", applies: notFunds },
  { param: "fwd_peg", label: "Fwd PEG", group: "forward", timeframe: "none", source: "forward",
    status: "planned", render: "number", digits: 2, signed: false, suffix: "×", applies: notFunds },
  { param: "analyst_target_gap", label: "Target gap", group: "forward", timeframe: "none",
    source: "forward", status: "planned", render: "number", digits: 1, signed: true, suffix: "%",
    applies: notFunds,
    hint: "Distance to consensus target. The only column whose meaning depends on someone else's judgment — never rendered as upside, buy or sell." },
  { param: "days_to_earnings", label: "Days to earnings", group: "forward", timeframe: "none",
    source: "forward", status: "planned", render: "number", digits: 0, signed: false,
    applies: notFunds, hint: "A count and a date, never an alert." },
];

// ---------------------------------------------------------------------------
// Presets. A preset chooses which COLUMNS are visible; it never changes the rows, the sort or the
// filter. `All` is the union in group order, which the spec says is expected to be very wide.
// ---------------------------------------------------------------------------
export type PresetKey = "momentum" | "technicals" | "value" | "all";

export const PRESETS: Array<{ key: PresetKey; label: string; params: string[] | "all" }> = [
  {
    key: "momentum",
    label: "Momentum",
    params: [
      "close", "pct_off_52w_high", "pct_off_high_stored", "pct_above_low_stored",
      "realized_vol_20", "volume_ratio",
      "rsi_daily",
      "close_vs_ema21d", "close_vs_sma50d", "close_vs_sma200d",
      "rs_vs_spx_63b", "rs_vs_spx_126b", "rs_vs_spx_252b",
      "valuation_rank", "margin_rank",
    ],
  },
  {
    key: "technicals",
    label: "Technicals",
    params: [
      "rsi_hourly", "rsi_daily",
      "close_vs_ema21d", "close_vs_sma50d", "close_vs_sma200d",
      // The three weekly vs-average columns, added 2026-09-20. Without them this preset showed a
      // TECHNICALS · WEEKLY band one column wide - accurate, since it did list rsi_weekly, but a
      // band heading over a single column in the preset actually named "Technicals" read as an
      // oversight. It was: the ten-band split gave the weekly readings a heading of their own and
      // this preset was not revisited.
      "rsi_weekly", "close_vs_ema21w", "close_vs_sma30w", "close_vs_sma200w",
      "ma_stack", "cross_50_200", "cross_21_50",
      "sma50_slope", "sma200_slope",
      "pct_off_52w_high", "pct_off_high_stored", "volume_ratio",
    ],
  },
  {
    key: "value",
    label: "Value",
    params: [
      "rev_growth_yoy", "rev_cagr_3y", "rev_cagr_5y", "rev_qoq_last", "rev_spark_8q",
      "eps_growth_yoy", "eps_cagr_3y", "eps_cagr_5y", "gross_margin_trend", "eps_spark_8q",
      "pe_trailing", "ps_ttm", "ev_sales", "ev_ebitda", "fcf_yield", "pb",
      "roic", "net_debt_ebitda", "fcf_margin", "share_count_yoy",
      "fwd_revenue", "fwd_eps", "fwd_pe", "fwd_peg", "analyst_target_gap", "days_to_earnings",
    ],
  },
  { key: "all", label: "All", params: "all" },
];

const BY_PARAM = new Map(COLUMNS.map((c) => [c.param, c]));
const GROUP_ORDER = new Map(GROUPS.map((g, i) => [g.key, i]));

/**
 * The visible columns for a preset, in group order.
 *
 * A preset lists params rather than embedding column objects, so a metric's definition lives in
 * exactly one place and appearing in three presets costs three strings. An unknown param here
 * would silently drop a column, so it throws — the same reasoning as the watchlist parser
 * refusing an undeclared theme.
 */
export function columnsFor(preset: PresetKey): Column[] {
  const spec = PRESETS.find((p) => p.key === preset);
  if (!spec) throw new Error(`unknown preset ${preset}`);
  const chosen = spec.params === "all"
    ? COLUMNS.slice()
    : spec.params.map((p) => {
      const c = BY_PARAM.get(p);
      if (!c) throw new Error(`preset ${preset} names unknown param ${p}`);
      return c;
    });
  return chosen.sort((a, b) =>
    (GROUP_ORDER.get(a.group) ?? 99) - (GROUP_ORDER.get(b.group) ?? 99) ||
    COLUMNS.indexOf(a) - COLUMNS.indexOf(b)
  );
}

/** The category row of the two-tier header, derived so it cannot drift from the columns. */
export function headerGroups(
  cols: Column[],
): Array<{ key: string; label: string; span: number }> {
  const out: Array<{ key: string; label: string; span: number }> = [];
  for (const c of cols) {
    const last = out[out.length - 1];
    if (last && last.key === c.group) last.span += 1;
    else out.push({ key: c.group, label: GROUPS.find((g) => g.key === c.group)?.label ?? c.group, span: 1 });
  }
  return out;
}

/** Where a group boundary falls, for the full-height rule between blocks. */
export function groupStarts(cols: Column[]): Set<string> {
  return new Set(cols.filter((c, i) => i > 0 && c.group !== cols[i - 1].group).map((c) => c.param));
}

// ---------------------------------------------------------------------------
// THE CELL STATE MODEL. Seven states, and the order they are tested in is the contract.
//
// Every one of these is a different sentence, and the design gives each its own treatment because
// a reader who cannot tell them apart will read a young listing as a broken one:
//
//   na        the question does not apply here. A fund has no P/E; an unrankable theme has no rank.
//   planned   the parameter is not built. Nobody has this value, not just this name.
//   null      we should have a value and do not.
//   warmup    computed, but still partly its own seed. Shown, never judged (hard constraint 8).
//   no-norm   a real value with no threshold set. We are tracking it, not judging it.
//   below/above/normal   judged against the norm in config/norms.yml.
//
// ORDER MATTERS, AND IT WAS WRONG THE FIRST TIME. `planned` was tested first, on the reasoning that
// an unbuilt column has nothing to say about any row. It has two costs, and both were measured
// rather than argued: with `planned` first, all 28 columns carrying an `applies` predicate are also
// `planned`, so the `na` branch was unreachable for every one of the 51 columns against every shape
// of security and cell - a state with its own colour, its own legend entry and its own CSS that
// could not appear on screen. And on the day Phase 4 flips those columns to `live`, every fund row
// in the Value block would change from "planned" to "n·a", which reads as news about the ETF when
// nothing about the ETF changed.
//
// So `na` is tested first. The two facts are not the same kind of fact: `applies` is permanent and
// about the (row, column) pair - SPY will never have a P/E - while `status` is temporary and about
// the column alone. Report the permanent one; it is already known and it will not change.
//
// After that: `na` outranks `null` because "cannot apply" is a stronger statement than "absent",
// and `warmup` outranks `no-norm` because it is the more specific reason not to colour a cell.
// ---------------------------------------------------------------------------
export type CellState =
  | "na" | "planned" | "null" | "warmup" | "no-norm" | "below" | "above" | "normal";

export interface CellLike {
  value?: number | null;
  verdict?: "below" | "normal" | "above" | null;
  has_norm?: boolean;
  suppressed_warmup?: boolean;
  /** Only signal cells carry these. */
  label?: string | null;
  tone?: string | null;
  /**
   * Only sparkline cells carry this: the last eight quarters, oldest first, with `null` for a
   * quarter the company did not report.
   *
   * NOTHING POPULATES IT YET. The financials ingest is Stage F, so today both sparkline columns
   * are `planned` and their cells never reach the renderer. It is declared here rather than added
   * later because the alternative is a component with no caller, and `scripts/ci/check_render_kinds.sh`
   * records which render kinds are reachable so this cannot be quietly forgotten.
   */
  series?: (number | null)[] | null;
  /**
   * Only rank cells carry this: how many securities were in the peer group the rank was taken
   * over. Same Stage F caveat as `series` — it comes from the `count(*) over (partition by theme)`
   * beside the `percent_rank()`, so the rank and its denominator cannot disagree.
   */
  peers?: number | null;
}

export function cellState(col: Column, sec: Security, cell: CellLike | undefined): CellState {
  if (col.applies && !col.applies(sec)) return "na";
  if (col.status === "planned") return "planned";
  // EACH RENDER KIND CARRIES ITS PAYLOAD IN A DIFFERENT FIELD, so "is this cell empty" is a
  // different question for each. A signal cell's payload is its label, a trace's is its series,
  // and a number's is its value. Testing `value` for all three would call a fully populated
  // eight-quarter trace "null", because a sparkline cell has no scalar value at all — latent
  // until Stage F lands the data, which is exactly when it would have been hardest to find.
  const empty = col.render === "chip"
    ? cell?.label === null || cell?.label === undefined
    : col.render === "sparkline"
    ? !cell?.series?.some((v) => typeof v === "number" && Number.isFinite(v))
    : cell?.value === null || cell?.value === undefined;
  if (empty) return "null";
  if (cell?.suppressed_warmup) return "warmup";
  // Signals are categorical: they have a tone rather than a norm verdict, and the tone IS the state
  // for colouring purposes. Deliberately not folded into below/above — see signal_cells' comment.
  if (col.render === "chip") {
    if (cell?.tone === "bull") return "above";
    if (cell?.tone === "bear") return "below";
    return "normal";
  }
  if (cell?.has_norm === false) return "no-norm";
  if (cell?.verdict === "below" || cell?.verdict === "above" || cell?.verdict === "normal") {
    return cell.verdict;
  }
  return "no-norm";
}

/** States that carry a verdict colour. Everything else is rendered quietly. */
export const COLOURED: ReadonlySet<CellState> = new Set<CellState>(["below", "above"]);

export function formatValue(v: number | null | undefined, digits: number, signed: boolean): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const s = v.toFixed(digits);
  return signed && v > 0 ? `+${s}` : s;
}

/**
 * A norm band as it appears under a column heading: "30 · 70", "≥ -25", "≤ 4".
 *
 * THE ONE-SIDED CASE USED TO PRINT A BARE NUMBER and it was ambiguous on screen: "vs SPX 126b"
 * showed "0" and "Off 52w high" showed "-25", neither of which says which side of the number is
 * the band. Two of the fifteen norms in config/norms.yml are floors and one is a ceiling, so this
 * is the common case, not the edge. The comparator is the whole meaning.
 */
export function formatNorm(n: { low: number | null; high: number | null } | undefined): string {
  if (!n) return "";
  if (n.low !== null && n.high !== null) return `${n.low} · ${n.high}`;
  if (n.low !== null) return `≥ ${n.low}`;
  if (n.high !== null) return `≤ ${n.high}`;
  return "";
}

/** Display names for watchlist themes. An unmapped theme falls back to its raw key, visibly. */
export const THEME_LABELS: Record<string, string> = {
  "ai-infrastructure": "AI infrastructure",
  "ai-silicon": "AI silicon",
  "diversified": "Diversified",
  "etfs": "ETFs",
  "foundry-analog-ip": "Foundry, analog & IP",
  "mega-cap-tech": "Mega-cap tech",
  "memory-storage": "Memory & storage",
  "saas": "SaaS",
  "semi-equipment": "Semi equipment",
};

/** Short label for a timeframe, shown under a metric name where the same label repeats. */
export const TIMEFRAME_LABELS: Record<Timeframe, string> = {
  daily: "D",
  weekly: "W",
  hourly: "H",
  none: "",
};
