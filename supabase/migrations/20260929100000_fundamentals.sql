-- 20260929100000_fundamentals.sql
-- Purpose:    Stage F2 - the 22 fundamental parameters, computed from SEC EDGAR (decision 0060), plus
--             the F1 fixes found by the backfill: wider quarter bands (Costco's 16-week quarter),
--             coverage over every item, a second CIK for ExxonMobil, and the tags the label probe
--             found in use. Adds bank detection, Massive share counts, and `fundamental_cells`, the
--             cell view the grid reads.
-- Depends on: sec_* (20260928100000), daily_features (20260913064000), tickers, norms, is_fund.
-- Grants:     select to service_role on every new relation; select, insert, update on the two new
--             tables the ingest writes (share_counts, sec_extra_ciks).
-- Reversing:  re-schedule swing-refresh-features from 20260927220000; drop fundamental_cells,
--             fundamental_daily, fundamental_quarters, share_counts, sec_extra_ciks, splits,
--             split_multiplier(), numeric_product(); drop
--             tickers.is_bank and sec_filers.sic; restore sec_quarters and sec_coverage from
--             20260928100000; delete the sec_concept_map rows added here. Facts stay valid.
--
-- ---------------------------------------------------------------------------
-- DECISIONS THIS FILE IMPLEMENTS (Bodhi, 2026-09-28; Project doc swing-tracker-f2-decisions-2026-09-28)
--   1. No operating income filed (KLAC, GE, XOM, JPM): EBITDA-based values are NULL, with a reason.
--   2. Banks (SEC SIC 6000-6199, i.e. JPM): EV/Sales, EV/EBITDA, Net debt/EBITDA, FCF yield, FCF
--      margin, ROIC are not applicable - the page's `applies` rule, fed by tickers.is_bank.
--   3. Market cap uses Massive's all-class share count when there is one (the dual-class names have
--      no single SEC cover-page count), else the SEC cover-page count.
--   4. Short-term investments never filed -> 0; filed before and not now -> null. Extended here to
--      debt and to leases by the same reasoning. REFINED 2026-09-29: a line absent for two years or
--      more while balance sheets kept coming counts as 0 (the company holds none); a shorter lapse
--      stays null with a reason. And cash, short-term investments, debt and equity must come from
--      the quarter's own balance sheet (<= 45 days) - or, for a line filed only in 10-Ks, from the
--      last fiscal-year end (<= 400 days). A line that stops at a quarter end is never carried.
--   5. The 11 column definitions approved the same day, now in DEFINITIONS §7.
--   6. (2026-09-29) Splits: every SEC per-share value and share count is converted to today's
--      basis with Massive's split history, so it matches the split-adjusted prices.
--
-- WHAT THIS IS NOT: point-in-time history. A quarter becomes visible on the date it was FIRST filed,
-- but carries its LATEST (possibly restated) values. Correct for today's grid; slightly optimistic for
-- a backtest. True point-in-time needs sec_facts filtered by `filed` per date - Phase 2.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Schema additions
-- ---------------------------------------------------------------------------
alter table public.tickers add column if not exists is_bank boolean not null default false;
comment on column public.tickers.is_bank is
  'Set by the SEC fundamentals ingest from the filer''s SIC code (6000-6199). EV- and EBITDA-based '
  'fundamentals do not apply to a bank. Not from the watchlist: SEC classifies, we do not.';

alter table public.sec_filers add column if not exists sic integer;

-- A company can be under more than one CIK: ExxonMobil reorganised under a new holding company in
-- 2026, whose filings start with the June quarter; its history is under the old CIK. The primary CIK
-- (sec_filers) keeps being checked; an extra CIK is fetched once, and again on full=1.
create table public.sec_extra_ciks (
  symbol      text        not null references public.tickers(symbol) on delete cascade,
  cik         integer     not null,
  note        text        not null,
  fetched_at  timestamptz,
  fact_rows   integer,
  primary key (symbol, cik)
);
alter table public.sec_extra_ciks enable row level security;
grant select, insert, update on table public.sec_extra_ciks to service_role;
-- Conditional: a fresh database (CI) has no tickers yet when migrations run.
insert into public.sec_extra_ciks (symbol, cik, note)
select 'XOM', 34088, 'Exxon Mobil Corporation before the 2026 holding-company reorganisation; facts through 2026-03-31 (label probe 2026-09-28)'
where exists (select 1 from public.tickers where symbol = 'XOM');

-- Massive (Polygon) ticker overview: weighted_shares_outstanding counts every class as if converted,
-- which is what a market cap needs for GOOGL, META, DELL, DDOG and SHOP.
create table public.share_counts (
  symbol           text        not null references public.tickers(symbol) on delete cascade,
  as_of            date        not null,
  weighted_shares  numeric,
  class_shares     numeric,
  source           text        not null,
  ingested_at      timestamptz not null default now(),
  primary key (symbol, as_of)
);
alter table public.share_counts enable row level security;
grant select, insert, update on table public.share_counts to service_role;
comment on table public.share_counts is
  'Shares outstanding per day from Massive ticker overview. weighted_shares is all classes as if '
  'converted - the market-cap denominator for multi-class companies. History starts when the '
  'ingest did (2026-09); earlier market caps use the SEC cover-page count.';

-- Stock splits, from Massive's splits reference data (decision 0060, Bodhi 2026-09-29).
--
-- WHY: prices are split-ADJUSTED (polygon.ts, adjusted=true). SEC per-share values and share counts
-- are in whatever basis they were FILED in. Measured 2026-09-29: 12 of the 43 companies split inside
-- the five-year window, and ServiceNow's TTM EPS came out at -1.62 because its derived fourth
-- quarter subtracted a pre-split nine-month EPS from a post-split full-year one.
--
-- RULE: a SEC value is converted to today's basis by every split executed AFTER the date that fixes
-- its basis - the FILED date for a per-share value (a filing issued after a split restates for it,
-- ASC 260), the AS-OF date for a share count. split_to/split_from is the share multiplier: a 10-for-1
-- is from 1, to 10; GE's 1-for-8 reverse split is from 8, to 1. Shares multiply by it; EPS divides.
--
-- "Today's basis" is the basis of the most recent split we know of - the same basis as stored prices
-- only if prices were re-fetched after that split. That is the price layer's job, not this one's.
create table public.splits (
  symbol          text        not null references public.tickers(symbol) on delete cascade,
  execution_date  date        not null,
  split_from      numeric     not null check (split_from > 0),
  split_to        numeric     not null check (split_to > 0),
  source          text        not null,
  ingested_at     timestamptz not null default now(),
  primary key (symbol, execution_date)
);
alter table public.splits enable row level security;
grant select, insert, update on table public.splits to service_role;

-- Exact product: numeric_mul keeps 10 x 2 x 1/8 exact where exp(sum(ln())) would not.
create aggregate public.numeric_product(numeric) (sfunc = numeric_mul, stype = numeric, initcond = '1');

-- The share multiplier from `p_basis` to today: 1 when no split followed.
create function public.split_multiplier(p_symbol text, p_basis date) returns numeric
language sql stable parallel safe as $fn$
  select public.numeric_product(split_to) / public.numeric_product(split_from)
  from public.splits
  where symbol = p_symbol and execution_date > p_basis
$fn$;
grant execute on function public.split_multiplier(text, date) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Tags found by the label probe (2026-09-28) and the new items. One forced re-fetch needed.
-- ---------------------------------------------------------------------------
insert into public.sec_concept_map (item, priority, taxonomy, concept, kind, note) values
  ('revenue',                  5, 'us-gaap', 'RevenuesNetOfInterestExpense', 'flow', 'banks (JPM)'),
  ('gross_profit',             1, 'us-gaap', 'GrossProfit', 'flow', null),
  ('cost_of_revenue',          1, 'us-gaap', 'CostOfRevenue', 'flow', 'gross profit = revenue - this when GrossProfit is absent'),
  ('cost_of_revenue',          2, 'us-gaap', 'CostOfGoodsAndServicesSold', 'flow', null),
  ('depreciation',             1, 'us-gaap', 'Depreciation', 'flow', 'MSFT, GOOGL, AVGO, INTU, MRVL, TXN, INTC, TSLA: D&A filed as two lines'),
  ('amortization_intangibles', 1, 'us-gaap', 'AmortizationOfIntangibleAssets', 'flow', null),
  ('debt_combined',            1, 'us-gaap', 'DebtLongtermAndShorttermCombinedAmount', 'instant', 'AMD, GE, KLAC, AVGO: long- and short-term together'),
  ('debt_noncurrent',          2, 'us-gaap', 'LongTermDebtAndCapitalLeaseObligations', 'instant', 'XOM, GE: includes finance leases'),
  ('debt_current',             3, 'us-gaap', 'LongTermDebtAndCapitalLeaseObligationsCurrent', 'instant', null),
  ('cash',                     2, 'us-gaap', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents', 'instant', 'GE since 2017 (probe 2026-09-29); includes restricted cash - used only when the plain tag is absent');

-- ---------------------------------------------------------------------------
-- 3. sec_quarters with wider bands.
--
-- Measured: Costco files 12/12/12/16-week quarters. Its 36-week year-to-date is 251 days and its
-- 16-week fourth quarter 112, both outside the first bands (255-290, 75-105), so Costco lost a
-- quarter every year. Quarter 75-120, nine months 245-290.
-- ---------------------------------------------------------------------------
create or replace view public.sec_quarters as
with src as (
  -- Per-share values to today's basis BEFORE any differencing, so a fourth quarter derived across a
  -- split subtracts like from like (the ServiceNow case). Flows are dollars and need nothing.
  select symbol, item, kind, unit, period_start, period_end, is_instant, days,
         case when kind = 'per_share' then val / public.split_multiplier(symbol, filed) else val end as val,
         accn, form, fy, fp, filed, concept, priority
  from public.sec_item_latest
  where kind in ('flow', 'per_share') and not is_instant
    and (days between 75 and 120 or days between 165 and 200 or days between 245 and 290 or days between 350 and 380)
),
chained as (
  select
    s.*,
    lag(s.period_end) over w as prev_end,
    lag(s.val)        over w as prev_val,
    lag(s.filed)      over w as prev_filed
  from src s
  window w as (partition by s.symbol, s.item, s.unit, s.period_start order by s.period_end)
),
reported as (
  select symbol, item, kind, unit, period_start, period_end, val, filed, accn, concept,
         false as derived
  from src
  where days between 75 and 120
),
derived as (
  select symbol, item, kind, unit,
         (prev_end + 1) as period_start,
         period_end,
         val - prev_val as val,
         greatest(filed, prev_filed) as filed,
         accn,
         concept,
         true as derived
  from chained
  where prev_end is not null
    and (period_end - prev_end) between 75 and 120
),
-- One row per quarter end: reported beats derived, then the newest filing. DISTINCT ON, not the F1
-- NOT EXISTS: measured on production 2026-09-29, the planner estimated the materialised CTEs at one
-- row each and chose a nested-loop anti join that compared 134 million pairs - 18.7 s for a view
-- that has to be refreshed inside fundamental_quarters every night. A sort is n log n and has no
-- estimate to get wrong. It also guarantees what the TTM sums rely on: never two rows for one
-- quarter, even if a filer reports two different three-month spans ending on the same day.
both_ as (
  select * from reported
  union all
  select * from derived
)
select distinct on (symbol, item, unit, period_end)
  symbol, item, kind, unit, period_start, period_end, val, filed, accn, concept, derived,
  (derived and kind = 'per_share') as approximate
from both_
order by symbol, item, unit, period_end, derived, filed desc, accn desc;

-- ---------------------------------------------------------------------------
-- 4. sec_coverage over EVERY item, including annual-only filers and non-flow durations. The first
--    version read quarters for flows and instants for balances, so a duration share count and an
--    annual-only 20-F filer both showed as "nothing" when the facts were there.
-- ---------------------------------------------------------------------------
create or replace view public.sec_coverage as
with items as (select distinct item, kind from public.sec_concept_map),
l as (
  select symbol, item, max(period_end) as last_period_end,
         string_agg(distinct concept, ', ') as concepts_used
  from public.sec_item_latest group by symbol, item
),
q as (
  select symbol, item, count(*) filter (where period_end >= current_date - 400) as quarters_last_400d
  from public.sec_quarters group by symbol, item
)
select
  f.symbol, f.cik, f.last_form, f.last_filed, it.item, it.kind,
  l.last_period_end,
  q.quarters_last_400d,
  l.concepts_used
from public.sec_filers f
cross join items it
left join l on l.symbol = f.symbol and l.item = it.item
left join q on q.symbol = f.symbol and q.item = it.item;

-- ---------------------------------------------------------------------------
-- 5. fundamental_quarters - one row per company per fiscal quarter: the quarter's own values, the
--    trailing-twelve-month sums, the balance sheet at (or carried to) the quarter end, and every
--    quarter-level parameter. USD only: ASML files in EUR and annually, TSM's SEC data is stale -
--    both are the analyst vendor's job.
--
--    TTM needs FOUR CONSECUTIVE quarters: the window of four rows must span 240-300 days between the
--    first and last quarter END (three gaps of 12-16 weeks). A missing quarter makes the span a year
--    and the TTM null, rather than summing four quarters out of five.
-- ---------------------------------------------------------------------------
create materialized view public.fundamental_quarters as
with q as (
  select symbol, period_end, item, val::double precision as val
  from public.sec_quarters
  where unit in ('USD', 'USD/shares')
),
p as (
  select
    symbol, period_end,
    max(val) filter (where item = 'revenue')                  as revenue,
    max(val) filter (where item = 'gross_profit')             as gross_profit,
    max(val) filter (where item = 'cost_of_revenue')          as cost_of_revenue,
    max(val) filter (where item = 'operating_income')         as operating_income,
    max(val) filter (where item = 'pretax_income')            as pretax_income,
    max(val) filter (where item = 'income_tax')               as income_tax,
    max(val) filter (where item = 'eps_diluted')              as eps,
    max(val) filter (where item = 'cfo')                      as cfo,
    max(val) filter (where item = 'capex')                    as capex_ppe,
    max(val) filter (where item = 'capex_software')           as capex_software,
    max(val) filter (where item = 'da')                       as da_combined,
    max(val) filter (where item = 'depreciation')             as depreciation,
    max(val) filter (where item = 'amortization_intangibles') as amortization_intangibles
  from q
  group by symbol, period_end
),
-- The date a quarter first became public: the earliest periodic filing carrying a fact for it.
vis as (
  select symbol, period_end, min(filed) as visible_from
  from public.sec_facts
  where form in ('10-Q', '10-K', '10-Q/A', '10-K/A', '20-F', '20-F/A', '40-F', '40-F/A')
  group by symbol, period_end
),
base as (
  select
    p.*,
    v.visible_from,
    -- D&A: the combined tag, else depreciation plus amortisation of intangibles (label probe: 12 of
    -- 14 companies checked file the two separately). Depreciation alone is NOT used as D&A.
    coalesce(p.da_combined, p.depreciation + coalesce(p.amortization_intangibles, 0)) as da,
    coalesce(p.gross_profit, p.revenue - p.cost_of_revenue) as gross,
    -- Capex = PP&E + capitalised software (DEFINITIONS §7 #4); software is rarely tagged, so it adds
    -- only where filed.
    p.capex_ppe + coalesce(p.capex_software, 0) as capex
  from p
  join vis v on v.symbol = p.symbol and v.period_end = p.period_end
),
ttm as (
  select
    b.*,
    ((b.period_end - lag(b.period_end, 3) over w) between 240 and 300) as ttm_ok,
    ((b.period_end - lag(b.period_end, 4) over w) between 350 and 380) as yoy_ok,
    ((b.period_end - lag(b.period_end, 1) over w) between 75 and 120)  as qoq_ok,
    lag(b.revenue, 1) over w as revenue_prev_q,
    lag(b.revenue, 4) over w as revenue_year_ago_q,
    case when count(b.revenue)          over w4 = 4 then sum(b.revenue)          over w4 end as revenue_ttm,
    case when count(b.gross)            over w4 = 4 then sum(b.gross)            over w4 end as gross_ttm,
    case when count(b.operating_income) over w4 = 4 then sum(b.operating_income) over w4 end as operating_income_ttm,
    case when count(b.pretax_income)    over w4 = 4 then sum(b.pretax_income)    over w4 end as pretax_ttm,
    case when count(b.income_tax)       over w4 = 4 then sum(b.income_tax)       over w4 end as tax_ttm,
    case when count(b.eps)              over w4 = 4 then sum(b.eps)              over w4 end as eps_ttm,
    case when count(b.cfo)              over w4 = 4 then sum(b.cfo)              over w4 end as cfo_ttm,
    case when count(b.capex)            over w4 = 4 then sum(b.capex)            over w4 end as capex_ttm,
    case when count(b.da)               over w4 = 4 then sum(b.da)               over w4 end as da_ttm,
    -- Sparklines: the last eight quarters, oldest first, holes as null.
    array_agg(b.revenue) over w8 as revenue_8q,
    array_agg(b.eps)     over w8 as eps_8q,
    (b.period_end - lag(b.period_end, 7) over w) as span_8q
  from base b
  window w  as (partition by b.symbol order by b.period_end),
         w4 as (partition by b.symbol order by b.period_end rows between 3 preceding and current row),
         w8 as (partition by b.symbol order by b.period_end rows between 7 preceding and current row)
),
ttm2 as (
  select
    t.*,
    case when t.ttm_ok then t.revenue_ttm          end as rev_ttm,
    case when t.ttm_ok then t.gross_ttm            end as gp_ttm,
    case when t.ttm_ok then t.operating_income_ttm end as oi_ttm,
    case when t.ttm_ok then t.pretax_ttm           end as pt_ttm,
    case when t.ttm_ok then t.tax_ttm              end as tx_ttm,
    case when t.ttm_ok then t.eps_ttm              end as e_ttm,
    case when t.ttm_ok then t.cfo_ttm              end as c_ttm,
    case when t.ttm_ok then t.capex_ttm            end as x_ttm,
    case when t.ttm_ok then t.da_ttm               end as d_ttm
  from ttm t
),
hist as (
  select
    t.*,
    lag(t.rev_ttm, 12) over w as rev_ttm_12q, ((t.period_end - lag(t.period_end, 12) over w) between 1070 and 1120) as span12_ok,
    lag(t.rev_ttm, 20) over w as rev_ttm_20q, ((t.period_end - lag(t.period_end, 20) over w) between 1795 and 1850) as span20_ok,
    lag(t.e_ttm, 4)    over w as eps_ttm_4q,
    lag(t.e_ttm, 12)   over w as eps_ttm_12q,
    lag(t.e_ttm, 20)   over w as eps_ttm_20q,
    lag(t.gp_ttm, 4)   over w as gp_ttm_4q,
    lag(t.rev_ttm, 4)  over w as rev_ttm_4q
  from ttm2 t
  window w as (partition by t.symbol order by t.period_end)
),
-- ---- Balance sheet, carried to each quarter end --------------------------
-- Balance items are per balance-sheet date. Cash, short-term investments, debt and equity must come
-- from the quarter's OWN balance sheet (within 45 days of its end) - or, for a line the company files
-- only in its 10-K, from its last fiscal-year end (<= 400 days; see fy_ends). Otherwise an older
-- value means the company stopped using the tag we read - measured 2026-09-29, NVDA's
-- MarketableSecuritiesCurrent stops after 2025-10 and MU's LongTermDebt after 2025-11. Carrying a
-- nine-month-old $49B forward would be a quietly wrong EV; null with a reason is the honest answer.
-- Operating leases are carried up to 400 days, because some companies file them annually only
-- (AAPL, measured).
bal as (
  select symbol, period_end as d,
    max(val::double precision) filter (where item = 'cash')                  as cash,
    max(val::double precision) filter (where item = 'st_investments')        as st_inv,
    max(val::double precision) filter (where item = 'equity')                as equity,
    coalesce(
      max(val::double precision) filter (where item = 'debt_combined'),
      coalesce(
        max(val::double precision) filter (where item = 'debt_total'),
        max(val::double precision) filter (where item = 'debt_noncurrent')
          + coalesce(max(val::double precision) filter (where item = 'debt_current'), 0)
      ) + coalesce(max(val::double precision) filter (where item = 'short_term_borrowings'),
                   max(val::double precision) filter (where item = 'commercial_paper'), 0)
    ) as debt,
    coalesce(
      max(val::double precision) filter (where item = 'op_lease_total'),
      max(val::double precision) filter (where item = 'op_lease_noncurrent')
        + coalesce(max(val::double precision) filter (where item = 'op_lease_current'), 0)
    ) as leases
  from public.sec_item_latest
  where is_instant and unit = 'USD'
  group by symbol, period_end
),
timeline as (
  select symbol, period_end as d, true as is_q, null::double precision as cash, null::double precision as st_inv,
         null::double precision as equity, null::double precision as debt, null::double precision as leases
  from base
  union all
  select symbol, d, false, cash, st_inv, equity, debt, leases from bal
),
grp as (
  select tl.*,
    count(cash)   over w as g_cash,   count(st_inv) over w as g_st,
    count(equity) over w as g_eq,     count(debt)   over w as g_debt,
    count(leases) over w as g_lease
  from timeline tl
  window w as (partition by symbol order by d, is_q)
),
-- Each count-group holds exactly one non-null value of its item (the row that opened it), so max()
-- over the group is that value; no ordering, no reliance on which peer comes first.
carried as (
  select g.symbol, g.d, g.is_q,
    max(cash)   over (partition by symbol, g_cash)  as cash_c,
    max(case when cash   is not null then d end) over (partition by symbol, g_cash)  as cash_d,
    max(st_inv) over (partition by symbol, g_st)    as st_c,
    max(case when st_inv is not null then d end) over (partition by symbol, g_st)    as st_d,
    max(equity) over (partition by symbol, g_eq)    as eq_c,
    max(case when equity is not null then d end) over (partition by symbol, g_eq)    as eq_d,
    max(debt)   over (partition by symbol, g_debt)  as debt_c,
    max(case when debt   is not null then d end) over (partition by symbol, g_debt)  as debt_d,
    max(leases) over (partition by symbol, g_lease) as lease_c,
    max(case when leases is not null then d end) over (partition by symbol, g_lease) as lease_d
  from grp g
),
-- Fiscal-year ends: a balance line filed only in the 10-K (CAT's debt - measured 2026-09-29, its
-- 10-Qs carry no standard debt tag at all) is dated at one, and may be carried up to 400 days, like
-- leases. A line whose last value is dated at a QUARTER end and then stops is a lapse, not an annual
-- habit (NVDA, MU), and gets no such allowance.
fy_ends as (
  select distinct symbol, period_end as d
  from public.sec_item_latest
  where not is_instant and days between 350 and 380
),
bq as (
  select c.symbol, c.d as period_end,
    case when c.d - c.cash_d  <= 45 or (fc.d is not null and c.d - c.cash_d <= 400) then c.cash_c end as cash,
    case when c.d - c.eq_d    <= 45 or (fe.d is not null and c.d - c.eq_d   <= 400) then c.eq_c   end as equity,
    -- Decision 4 as refined 2026-09-29: not filed as of this quarter, or not filed for two years
    -- (730 days) while balance sheets kept coming -> the company holds none: 0. A lapse shorter than
    -- that is most likely a tag change we have not mapped -> null, with a reason on the cell.
    -- Measured: CAT's short-term investments last appear 2014, STX 2012, LRCX 2015 (holding none);
    -- NVDA's stop 2025-10 (a tag change). Cash and equity are never 0 - a company always has both.
    case when c.d - c.st_d    <= 45 or (fs.d is not null and c.d - c.st_d   <= 400) then c.st_c
         when c.st_d    is null or c.d - c.st_d    >= 730 then 0 end as st_inv,
    case when c.d - c.debt_d  <= 45 or (fd.d is not null and c.d - c.debt_d <= 400) then c.debt_c
         when c.debt_d  is null or c.d - c.debt_d  >= 730 then 0 end as debt,
    case when c.d - c.lease_d <= 400 then c.lease_c when c.lease_d is null or c.d - c.lease_d >= 730 then 0 end as leases
  from carried c
  left join fy_ends fc on fc.symbol = c.symbol and fc.d = c.cash_d
  left join fy_ends fe on fe.symbol = c.symbol and fe.d = c.eq_d
  left join fy_ends fs on fs.symbol = c.symbol and fs.d = c.st_d
  left join fy_ends fd on fd.symbol = c.symbol and fd.d = c.debt_d
  where c.is_q
)
select
  h.symbol,
  h.period_end,
  h.visible_from,
  h.revenue, h.eps, h.gross, h.operating_income, h.da, h.cfo, h.capex,
  h.rev_ttm, h.gp_ttm, h.oi_ttm, h.e_ttm as eps_ttm, h.c_ttm as cfo_ttm, h.x_ttm as capex_ttm, h.d_ttm as da_ttm,
  b.cash, b.st_inv, b.equity, b.debt, b.leases,
  -- EBITDA = operating income + D&A (DEFINITIONS §7). Null when either is not filed - decision 1.
  (h.oi_ttm + h.d_ttm) as ebitda_ttm,
  (h.oi_ttm is null) as no_operating_income,
  -- Which balance-sheet inputs are missing for this quarter, for the cells' hover text.
  nullif(concat_ws(', ',
    case when b.cash   is null then 'cash' end,
    case when b.st_inv is null then 'short-term investments' end,
    case when b.debt   is null then 'debt' end,
    case when b.leases is null then 'operating leases' end), '') as ev_gap,
  (b.equity is null) as no_equity,
  -- Net debt (§7): debt + operating leases - cash - short-term investments.
  (b.debt + b.leases - b.cash - b.st_inv) as net_debt,
  -- ---- quarter-level parameters --------------------------------------------
  case when h.qoq_ok and h.revenue_prev_q > 0 then 100 * (h.revenue / h.revenue_prev_q - 1) end as rev_qoq_last,
  case when h.yoy_ok and h.revenue_year_ago_q > 0 then 100 * (h.revenue / h.revenue_year_ago_q - 1) end as rev_growth_yoy,
  case when h.span12_ok and h.rev_ttm > 0 and h.rev_ttm_12q > 0 then 100 * (power(h.rev_ttm / h.rev_ttm_12q, 1.0 / 3) - 1) end as rev_cagr_3y,
  case when h.span20_ok and h.rev_ttm > 0 and h.rev_ttm_20q > 0 then 100 * (power(h.rev_ttm / h.rev_ttm_20q, 1.0 / 5) - 1) end as rev_cagr_5y,
  case when h.yoy_ok and h.e_ttm > 0 and h.eps_ttm_4q > 0 then 100 * (h.e_ttm / h.eps_ttm_4q - 1) end as eps_growth_yoy,
  case when h.span12_ok and h.e_ttm > 0 and h.eps_ttm_12q > 0 then 100 * (power(h.e_ttm / h.eps_ttm_12q, 1.0 / 3) - 1) end as eps_cagr_3y,
  case when h.span20_ok and h.e_ttm > 0 and h.eps_ttm_20q > 0 then 100 * (power(h.e_ttm / h.eps_ttm_20q, 1.0 / 5) - 1) end as eps_cagr_5y,
  case when h.rev_ttm > 0 then 100 * h.gp_ttm / h.rev_ttm end as gross_margin_ttm,
  case when h.yoy_ok and h.rev_ttm > 0 and h.rev_ttm_4q > 0
       then 100 * (h.gp_ttm / h.rev_ttm - h.gp_ttm_4q / h.rev_ttm_4q) end as gross_margin_trend,
  case when h.rev_ttm > 0 then 100 * (h.c_ttm - h.x_ttm) / h.rev_ttm end as fcf_margin,
  -- ROIC (§7): NOPAT / (total debt + equity - cash); tax rate from the filing, clamped to 0-40% so a
  -- tax-benefit year does not flip the sign. Debt here includes leases, the same debt as net debt.
  case when h.pt_ttm > 0 and (b.debt + b.leases + b.equity - b.cash) > 0
       then 100 * h.oi_ttm * (1 - least(greatest(coalesce(h.tx_ttm / h.pt_ttm, 0), 0), 0.40))
            / (b.debt + b.leases + b.equity - b.cash) end as roic,
  case when (h.oi_ttm + h.d_ttm) > 0 then (b.debt + b.leases - b.cash - b.st_inv) / (h.oi_ttm + h.d_ttm) end as net_debt_ebitda,
  case when h.span_8q between 600 and 740 then h.revenue_8q end as revenue_8q,
  case when h.span_8q between 600 and 740 then h.eps_8q end as eps_8q
from hist h
left join bq b on b.symbol = h.symbol and b.period_end = h.period_end;

create unique index fundamental_quarters_pk on public.fundamental_quarters (symbol, period_end);

comment on materialized view public.fundamental_quarters is
  'One row per company per fiscal quarter: own-quarter values, TTM sums (four consecutive quarters '
  'only), the quarter''s own balance sheet (leases carried <= 400 days), and the quarter-level parameters. '
  'visible_from = first periodic filing for the quarter. Values are the LATEST filed (restated). USD '
  'only. Decision 0060, DEFINITIONS §7.';

grant select on public.fundamental_quarters to service_role;

-- ---------------------------------------------------------------------------
-- 6. fundamental_daily - one row per company per grid day: the newest quarter VISIBLE on that day
--    (first filed strictly before it), the newest share count, and the price-dependent parameters.
--
--    Carried forward with the same count-group trick as above, never with a date-range join: the
--    2026-09-15 outage was a band join, and the shape check forbids one.
-- ---------------------------------------------------------------------------
create materialized view public.fundamental_daily as
with days as (
  select f.symbol, f.d, f.close
  from public.daily_features f
  join public.tickers t on t.symbol = f.symbol
  where t.active and not t.is_index and not t.is_fund
),
events as (
  -- A quarter counts from the day AFTER its first filing: a 10-Q filed after the close is not known
  -- to that day's close.
  select symbol, (visible_from + 1) as d, period_end as quarter_key,
         null::date as massive_key, null::date as cover_key
  from public.fundamental_quarters
  union all
  select symbol, as_of, null, as_of, null from public.share_counts
  union all
  -- SEC cover-page shares: the fact's own date is the cover date; it is known from its filing.
  select symbol, filed + 1, null, null, period_end
  from public.sec_item_latest where item = 'shares_outstanding' and unit = 'shares'
),
tl as (
  select symbol, d, 0 as ord, quarter_key, massive_key, cover_key, null::double precision as close
  from events
  union all
  select symbol, d, 1, null, null, null, close from days
),
g as (
  select tl.*,
    count(quarter_key) over w as gq,
    count(massive_key) over w as gm,
    count(cover_key)   over w as gc
  from tl
  window w as (partition by symbol order by d, ord)
),
-- max() over the group, not first_value(): events on the same day are window PEERS and share one
-- count, so first_value could land on a share-count event whose quarter_key is null. Within a group
-- the only non-null keys are the event(s) that opened it, and the newest is the one wanted.
c as (
  select g.symbol, g.d, g.close, g.ord,
    max(quarter_key) over (partition by symbol, gq) as qk,
    max(massive_key) over (partition by symbol, gm) as mk,
    max(cover_key)   over (partition by symbol, gc) as ck
  from g
),
cover as (
  -- Cover-page shares with the value a year earlier, for share_count_yoy.
  -- Converted to today's basis by the splits after the cover DATE (the count's own as-of date), so a
  -- year-on-year change across a split is the real change, not the split ratio.
  select symbol, period_end as ck,
         (val * public.split_multiplier(symbol, period_end))::double precision as shares
  from (select distinct on (symbol, period_end) symbol, period_end, val
        from public.sec_item_latest where item = 'shares_outstanding' and unit = 'shares'
        order by symbol, period_end, filed desc) s
),
cover_yoy as (
  -- The count a year before: the latest cover date at least 330 days earlier.
  select a.symbol, a.ck, a.shares,
    (select b.shares from cover b
      where b.symbol = a.symbol and b.ck <= a.ck - 330 and b.ck >= a.ck - 420
      order by b.ck desc limit 1) as shares_year_ago
  from cover a
),
x as (
  select
    c.symbol, c.d, c.close,
    q.period_end as quarter_end,
    coalesce((sc.weighted_shares * public.split_multiplier(sc.symbol, sc.as_of))::double precision, cy.shares) as shares,
    (sc.weighted_shares is not null) as shares_from_massive,
    cy.shares as cover_shares, cy.shares_year_ago as cover_shares_year_ago,
    q.cash, q.st_inv, q.debt, q.leases, q.equity,
    q.rev_ttm, q.eps_ttm, q.cfo_ttm, q.capex_ttm, q.ebitda_ttm, q.no_operating_income, q.ev_gap, q.no_equity,
    q.rev_growth_yoy, q.rev_cagr_3y, q.rev_cagr_5y, q.rev_qoq_last,
    q.eps_growth_yoy, q.eps_cagr_3y, q.eps_cagr_5y, q.gross_margin_trend, q.gross_margin_ttm,
    q.roic, q.net_debt_ebitda, q.fcf_margin, q.revenue_8q, q.eps_8q
  from c
  left join public.fundamental_quarters q on q.symbol = c.symbol and q.period_end = c.qk
  left join public.share_counts sc on sc.symbol = c.symbol and sc.as_of = c.mk
  left join cover_yoy cy on cy.symbol = c.symbol and cy.ck = c.ck
  where c.ord = 1
),
v as (
  select
    x.symbol, x.d, x.quarter_end, x.shares, x.shares_from_massive,
    (x.close * x.shares) as market_cap,
    (x.close * x.shares + x.debt + x.leases - x.cash - x.st_inv) as ev,
    x.no_operating_income, x.ev_gap, x.no_equity,
    case when x.eps_ttm > 0 then x.close / x.eps_ttm end as pe_trailing,
    case when x.rev_ttm > 0 then x.close * x.shares / x.rev_ttm end as ps_ttm,
    case when x.rev_ttm > 0 then (x.close * x.shares + x.debt + x.leases - x.cash - x.st_inv) / x.rev_ttm end as ev_sales,
    case when x.ebitda_ttm > 0 then (x.close * x.shares + x.debt + x.leases - x.cash - x.st_inv) / x.ebitda_ttm end as ev_ebitda,
    case when x.close * x.shares > 0 then 100 * (x.cfo_ttm - x.capex_ttm) / (x.close * x.shares) end as fcf_yield,
    case when x.equity > 0 then x.close * x.shares / x.equity end as pb,
    case when x.cover_shares_year_ago > 0 then 100 * (x.cover_shares / x.cover_shares_year_ago - 1) end as share_count_yoy,
    x.rev_growth_yoy, x.rev_cagr_3y, x.rev_cagr_5y, x.rev_qoq_last,
    x.eps_growth_yoy, x.eps_cagr_3y, x.eps_cagr_5y, x.gross_margin_trend, x.gross_margin_ttm,
    x.roic, x.net_debt_ebitda, x.fcf_margin,
    x.revenue_8q, x.eps_8q, x.eps_ttm, x.ebitda_ttm
  from x
)
select
  v.*,
  -- Sector ranks (DEFINITIONS §3): 1 = highest FCF yield (cheapest) / highest TTM gross margin, over
  -- the rankable theme on the same day. Funds and banks are not in a peer group for these.
  case when v.fcf_yield is not null and t.rankable and not t.is_bank
       then rank() over (partition by t.theme, v.d, (v.fcf_yield is not null and t.rankable and not t.is_bank) order by v.fcf_yield desc) end as valuation_rank,
  case when v.fcf_yield is not null and t.rankable and not t.is_bank
       then count(*) over (partition by t.theme, v.d, (v.fcf_yield is not null and t.rankable and not t.is_bank)) end as valuation_peers,
  case when v.gross_margin_ttm is not null and t.rankable and not t.is_bank
       then rank() over (partition by t.theme, v.d, (v.gross_margin_ttm is not null and t.rankable and not t.is_bank) order by v.gross_margin_ttm desc) end as margin_rank,
  case when v.gross_margin_ttm is not null and t.rankable and not t.is_bank
       then count(*) over (partition by t.theme, v.d, (v.gross_margin_ttm is not null and t.rankable and not t.is_bank)) end as margin_peers
from v
join public.tickers t on t.symbol = v.symbol;

create unique index fundamental_daily_pk on public.fundamental_daily (symbol, d);
create index fundamental_daily_d_idx on public.fundamental_daily (d);

comment on materialized view public.fundamental_daily is
  'One row per company per grid day: the newest quarter visible that day (first filed before it), '
  'the newest share count, and the price-dependent fundamentals. Carried forward by count-groups, '
  'never by a range join. Decision 0060.';

grant select on public.fundamental_daily to service_role;

-- ---------------------------------------------------------------------------
-- 7. fundamental_cells - the grid's shape: one row per (symbol, day, param), value, verdict, and the
--    two payloads Stage B built renderers for (series, peers). `reason` explains a null that is not
--    simply "not filed yet", for the cell's hover text.
--    The verdict CASE is the fourth copy of the rule; check_formulas.sql holds all four to one
--    reference expression.
-- ---------------------------------------------------------------------------
create view public.fundamental_cells as
with cells as (
  select f.symbol, f.d, c.param, c.value, c.series, c.peers, c.reason
  from public.fundamental_daily f
  cross join lateral ( values
    ('pe_trailing'::text,      f.pe_trailing,        null::double precision[], null::bigint,
       case when f.pe_trailing is null and f.eps_ttm <= 0 then 'TTM EPS at or below zero' end),
    ('ps_ttm',                 f.ps_ttm,             null, null, null::text),
    ('ev_sales',               f.ev_sales,           null, null,
       case when f.ev_sales is null and f.ev_gap is not null then 'not filed for this quarter: ' || f.ev_gap end),
    ('ev_ebitda',              f.ev_ebitda,          null, null,
       case when f.ev_ebitda is not null then null
            when f.no_operating_income then 'operating income not filed'
            when f.ev_gap is not null then 'not filed for this quarter: ' || f.ev_gap
            when f.ebitda_ttm <= 0 then 'EBITDA at or below zero' end),
    ('fcf_yield',              f.fcf_yield,          null, null, null),
    ('pb',                     f.pb,                 null, null,
       case when f.pb is null and f.no_equity then 'equity not filed for this quarter' end),
    ('roic',                   f.roic,               null, null,
       case when f.roic is not null then null
            when f.no_operating_income then 'operating income not filed'
            when f.ev_gap is not null or f.no_equity then 'balance sheet incomplete for this quarter' end),
    ('net_debt_ebitda',        f.net_debt_ebitda,    null, null,
       case when f.net_debt_ebitda is not null then null
            when f.no_operating_income then 'operating income not filed'
            when f.ev_gap is not null then 'not filed for this quarter: ' || f.ev_gap
            when f.ebitda_ttm <= 0 then 'EBITDA at or below zero' end),
    ('fcf_margin',             f.fcf_margin,         null, null, null),
    ('share_count_yoy',        f.share_count_yoy,    null, null, null),
    ('rev_growth_yoy',         f.rev_growth_yoy,     null, null, null),
    ('rev_cagr_3y',            f.rev_cagr_3y,        null, null, null),
    ('rev_cagr_5y',            f.rev_cagr_5y,        null, null, null),
    ('rev_qoq_last',           f.rev_qoq_last,       null, null, null),
    ('eps_growth_yoy',         f.eps_growth_yoy,     null, null,
       case when f.eps_growth_yoy is null and f.eps_ttm <= 0 then 'growth off a loss is not meaningful' end),
    ('eps_cagr_3y',            f.eps_cagr_3y,        null, null, null),
    ('eps_cagr_5y',            f.eps_cagr_5y,        null, null, null),
    ('gross_margin_trend',     f.gross_margin_trend, null, null, null),
    ('rev_spark_8q',           null,                 f.revenue_8q, null, null),
    ('eps_spark_8q',           null,                 f.eps_8q,     null, null),
    ('valuation_rank',         f.valuation_rank::double precision, null, f.valuation_peers, null),
    ('margin_rank',            f.margin_rank::double precision,    null, f.margin_peers,    null)
  ) c(param, value, series, peers, reason)
)
select
  cells.symbol, cells.d, cells.param, cells.value, cells.series, cells.peers, cells.reason,
  n.low as norm_low, n.high as norm_high,
  case
    when cells.value is null    then null::text
    when n.param is null        then null::text
    when n.low  is not null and cells.value < n.low  then 'below'::text
    when n.high is not null and cells.value > n.high then 'above'::text
    else 'normal'::text
  end as verdict,
  n.param is not null as has_norm,
  false as suppressed_warmup
from cells
left join public.norms n on n.param = cells.param;

comment on view public.fundamental_cells is
  'Fundamentals in the grid''s cell shape: (symbol, d, param) with value, verdict, and the sparkline '
  'series / rank peers payloads. reason says why a value is null when the reason is not "not filed". '
  'Decision 0060.';

grant select on public.fundamental_cells to service_role;

-- ---------------------------------------------------------------------------
-- 8. The refresh job. fundamental_quarters reads the SEC views; fundamental_daily reads it and
--    daily_features, so it goes after both. 22:45 as before - the SEC ingest ran at 11:20/11:40.
-- ---------------------------------------------------------------------------
select cron.unschedule(jobid) from cron.job where jobname = 'swing-refresh-features';

select cron.schedule(
  'swing-refresh-features',
  '45 22 * * 1-5',
  $job$
  refresh materialized view concurrently public.daily_features;
  refresh materialized view concurrently public.weekly_features;
  refresh materialized view concurrently public.daily_signals;
  refresh materialized view concurrently public.market_history;
  refresh materialized view concurrently public.hourly_features;
  refresh materialized view concurrently public.fundamental_quarters;
  refresh materialized view concurrently public.fundamental_daily;
  $job$
);
