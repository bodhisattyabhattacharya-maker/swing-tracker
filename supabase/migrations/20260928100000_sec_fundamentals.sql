-- 20260928100000_sec_fundamentals.sql
-- Purpose:    SEC EDGAR fundamentals, raw and point-in-time (decision 0059, Stage F1). `sec_facts`
--             stores every filed value of a whitelisted concept with its own filing date and
--             accession; `sec_concept_map` is the whitelist and the fallback order between
--             alternative tags; the views resolve tags, pick the newest filing per period, and turn
--             year-to-date filings into quarters. Two scheduled jobs keep it current.
-- Depends on: tickers (20260912120000), is_fund (20260917060000), pg_cron / pg_net / vault.
-- Used by:    nothing on the grid yet - Stage F2 builds the fundamental parameters on these views.
-- Grants:     select, insert, update on sec_facts and sec_filers, select on the map and the views,
--             to service_role. Nothing to anon or authenticated.
-- Reversing:  unschedule swing-ingest-sec-a/-b; drop the five views; drop sec_facts, sec_filers,
--             sec_concept_map. No other object references them.
--
-- ---------------------------------------------------------------------------
-- WHY RAW FACTS, NOT A CLEANED TABLE
--
-- Measured on production 2026-09-27 (Project doc swing-tracker-edgar-probe-2026-09-27.md):
--   * companyfacts keeps every filed value. AAPL diluted EPS: 25 periods whose value differs between
--     filings (the 2020 split), each with its own `filed` date. Storing all of them is what makes a
--     backtest standing on a past date able to see only what had been filed by then.
--   * tags differ by company and change over time: AMZN's capex moved from
--     PaymentsToAcquirePropertyPlantAndEquipment to PaymentsToAcquireProductiveAssets in 2017; MU's
--     debt tag changed in 2025; MSFT files D&A under a company-specific tag companyfacts does not
--     carry at all.
-- So the table stores what SEC filed, untouched, and every judgment - which tag stands for which
-- item, which filing wins, how a quarter is derived - lives in SQL on top, where it can be read,
-- tested and changed without re-fetching.
--
-- ---------------------------------------------------------------------------
-- THE THREE STRUCTURAL FACTS THE VIEWS HANDLE
--
--   1. Cash-flow lines in a 10-Q are YEAR TO DATE (3, 6, 9 months), not the quarter.
--   2. Q4 is never filed as a quarter: the 10-K carries the fiscal year.
--   3. A period can be filed more than once, with different values.
--
-- sec_item_latest takes the newest filing per period (3). sec_quarters takes a reported three-month
-- value where one exists and otherwise differences consecutive year-to-date values that share a
-- start date (1, 2): Q2 = H1 - Q1, Q3 = 9M - H1, Q4 = FY - 9M. Derived rows say so (`derived`).
--
-- PER-SHARE ITEMS ARE DIFFERENCED TOO, AND FLAGGED `approximate`. FY EPS minus 9-month EPS is not
-- Q4 EPS exactly - the share counts differ between the two denominators - but it is the standard
-- approximation and the only one available when Q4 is not filed. F2 decides whether to use it; this
-- layer only refuses to hide that it is an approximation.
-- ---------------------------------------------------------------------------

create table public.sec_filers (
  symbol            text        primary key references public.tickers(symbol) on delete cascade,
  cik               integer     not null,
  -- The newest periodic filing whose facts have REACHED companyfacts. Advanced only when that
  -- accession appears in the document (sec.ts / index.ts), so a lagging SEC index is retried.
  last_accn         text,
  last_form         text,
  last_filed        date,
  facts_fetched_at  timestamptz,
  fact_rows         integer,
  updated_at        timestamptz not null default now()
);

comment on table public.sec_filers is
  'SEC identity and fetch state per operating company. cik comes from SEC company_tickers.json. '
  'last_accn is the newest periodic filing already stored - the ingest re-fetches companyfacts only '
  'when submissions shows a newer one. Decision 0059.';

create table public.sec_facts (
  symbol        text             not null references public.tickers(symbol) on delete cascade,
  cik           integer          not null,
  taxonomy      text             not null,          -- us-gaap | dei | ifrs-full | srt
  concept       text             not null,
  unit          text             not null,          -- USD, EUR, USD/shares, shares, ...
  -- Instants (balance sheet, cover-page shares) carry period_start = period_end so the key has no
  -- nulls; is_instant says which.
  period_start  date             not null,
  period_end    date             not null,
  is_instant    boolean          not null,
  val           numeric          not null,
  accn          text             not null,
  form          text,
  fy            integer,
  fp            text,
  filed         date             not null,
  frame         text,
  ingested_at   timestamptz      not null default now(),
  primary key (symbol, taxonomy, concept, unit, period_start, period_end, accn),
  check (period_start <= period_end),
  check (not is_instant or period_start = period_end)
);

create index sec_facts_symbol_concept_idx on public.sec_facts (symbol, taxonomy, concept);

comment on table public.sec_facts is
  'Every filed value of a whitelisted XBRL concept, as SEC companyfacts publishes it: one row per '
  '(concept, unit, period, accession). Restatements are ADDITIONAL rows with a later filed date, '
  'never overwrites. A concept a company did not file has no row - never a zero. Decision 0059.';

alter table public.sec_filers enable row level security;
alter table public.sec_facts  enable row level security;
grant select, insert, update on table public.sec_filers to service_role;
grant select, insert, update on table public.sec_facts  to service_role;

-- ---------------------------------------------------------------------------
-- The whitelist and the fallback order.
--
-- `kind` decides which units a fact may carry (money: a currency code; per_share: X/shares; shares:
-- shares) and whether quarters may be derived. Currency is NOT forced to USD here: ASML files its
-- US-GAAP 20-F in EUR, and silently dropping or mislabelling it would be worse than carrying the
-- unit through. Stage F2 converts where it compares.
--
-- Alternates are listed only where they are TRUE SYNONYMS for the item. LongTermDebt (total) is not
-- a fallback for LongTermDebtNoncurrent, and CommercialPaper is not a fallback for
-- ShortTermBorrowings - those are separate items, and F2 composes them, because summing a total with
-- its own parts is exactly the double count this layer must not make possible.
-- ---------------------------------------------------------------------------
create table public.sec_concept_map (
  item      text     not null,
  priority  smallint not null,
  taxonomy  text     not null,
  concept   text     not null,
  kind      text     not null check (kind in ('flow', 'per_share', 'instant', 'shares')),
  note      text,
  primary key (item, priority),
  unique (taxonomy, concept)
);

comment on table public.sec_concept_map is
  'Which XBRL concepts stand for which fundamental item, in fallback order (priority 1 first), '
  'resolved per period and per filing. Also the ingest''s whitelist: a concept not listed here is '
  'not stored. Adding a concept needs one forced re-fetch (scope=fundamentals&full=1). Decision 0059.';

insert into public.sec_concept_map (item, priority, taxonomy, concept, kind, note) values
  ('revenue',               1, 'us-gaap', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'flow', 'ASC 606, 2018 on'),
  ('revenue',               2, 'us-gaap', 'Revenues', 'flow', null),
  ('revenue',               3, 'us-gaap', 'SalesRevenueNet', 'flow', 'pre-2018'),
  ('revenue',               4, 'us-gaap', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'flow', null),
  ('operating_income',      1, 'us-gaap', 'OperatingIncomeLoss', 'flow', null),
  ('net_income',            1, 'us-gaap', 'NetIncomeLoss', 'flow', null),
  ('pretax_income',         1, 'us-gaap', 'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest', 'flow', null),
  ('pretax_income',         2, 'us-gaap', 'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments', 'flow', null),
  ('income_tax',            1, 'us-gaap', 'IncomeTaxExpenseBenefit', 'flow', null),
  ('eps_diluted',           1, 'us-gaap', 'EarningsPerShareDiluted', 'per_share', 'diluted, not basic - DEFINITIONS §7'),
  ('eps_diluted',           2, 'us-gaap', 'EarningsPerShareBasicAndDiluted', 'per_share', 'filers with no dilution report one line'),
  ('shares_diluted_wavg',   1, 'us-gaap', 'WeightedAverageNumberOfDilutedSharesOutstanding', 'shares', 'period average, for EPS only'),
  ('da',                    1, 'us-gaap', 'DepreciationDepletionAndAmortization', 'flow', null),
  ('da',                    2, 'us-gaap', 'DepreciationAmortizationAndAccretionNet', 'flow', null),
  ('da',                    3, 'us-gaap', 'DepreciationAndAmortization', 'flow', 'MSFT files none of these three'),
  ('cfo',                   1, 'us-gaap', 'NetCashProvidedByUsedInOperatingActivities', 'flow', 'YTD in 10-Qs'),
  ('cfo',                   2, 'us-gaap', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations', 'flow', null),
  ('capex',                 1, 'us-gaap', 'PaymentsToAcquirePropertyPlantAndEquipment', 'flow', null),
  ('capex',                 2, 'us-gaap', 'PaymentsToAcquireProductiveAssets', 'flow', 'AMZN since 2017'),
  ('capex_software',        1, 'us-gaap', 'PaymentsToDevelopSoftware', 'flow', 'DEFINITIONS §7 #4'),
  ('capex_software',        2, 'us-gaap', 'PaymentsForSoftware', 'flow', null),
  ('cash',                  1, 'us-gaap', 'CashAndCashEquivalentsAtCarryingValue', 'instant', null),
  ('st_investments',        1, 'us-gaap', 'ShortTermInvestments', 'instant', 'MSFT, ARM'),
  ('st_investments',        2, 'us-gaap', 'MarketableSecuritiesCurrent', 'instant', 'AAPL, AMZN'),
  ('st_investments',        3, 'us-gaap', 'AvailableForSaleSecuritiesDebtSecuritiesCurrent', 'instant', 'MU'),
  ('debt_total',            1, 'us-gaap', 'LongTermDebt', 'instant', 'current + noncurrent, as one figure'),
  ('debt_current',          1, 'us-gaap', 'LongTermDebtCurrent', 'instant', null),
  ('debt_current',          2, 'us-gaap', 'DebtCurrent', 'instant', null),
  ('debt_noncurrent',       1, 'us-gaap', 'LongTermDebtNoncurrent', 'instant', null),
  ('short_term_borrowings', 1, 'us-gaap', 'ShortTermBorrowings', 'instant', null),
  ('commercial_paper',      1, 'us-gaap', 'CommercialPaper', 'instant', 'part of short-term borrowings for some filers - F2 must not add both'),
  ('op_lease_total',        1, 'us-gaap', 'OperatingLeaseLiability', 'instant', 'AAPL: annual only'),
  ('op_lease_current',      1, 'us-gaap', 'OperatingLeaseLiabilityCurrent', 'instant', null),
  ('op_lease_noncurrent',   1, 'us-gaap', 'OperatingLeaseLiabilityNoncurrent', 'instant', null),
  ('equity',                1, 'us-gaap', 'StockholdersEquity', 'instant', null),
  ('equity',                2, 'us-gaap', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest', 'instant', null),
  ('shares_outstanding',    1, 'dei',     'EntityCommonStockSharesOutstanding', 'shares', 'cover page, point in time - DEFINITIONS §7 #7');

grant select on public.sec_concept_map to service_role;

-- ---------------------------------------------------------------------------
-- sec_item_facts: facts expressed as items, one tag per (period, filing) - the highest-priority tag
-- present in THAT filing for THAT period. Resolved per period rather than per company because tags
-- change over time: an AMZN period before 2017 resolves to one tag, after 2017 to the other.
-- ---------------------------------------------------------------------------
create view public.sec_item_facts as
select distinct on (f.symbol, m.item, f.unit, f.period_start, f.period_end, f.accn)
  f.symbol,
  m.item,
  m.kind,
  f.unit,
  f.period_start,
  f.period_end,
  f.is_instant,
  (f.period_end - f.period_start) as days,
  f.val,
  f.accn,
  f.form,
  f.fy,
  f.fp,
  f.filed,
  f.concept,
  m.priority
from public.sec_facts f
join public.sec_concept_map m on m.taxonomy = f.taxonomy and m.concept = f.concept
where case m.kind
        when 'per_share' then f.unit like '%/shares'
        when 'shares'    then f.unit = 'shares'
        else f.unit !~ '/' and f.unit not in ('shares', 'pure')
      end
order by f.symbol, m.item, f.unit, f.period_start, f.period_end, f.accn, m.priority;

comment on view public.sec_item_facts is
  'sec_facts expressed as items via sec_concept_map: per (symbol, item, unit, period, accession) the '
  'highest-priority concept present. Every filing of a period is still here.';

-- ---------------------------------------------------------------------------
-- sec_item_latest: the CURRENT view - per period, the value from the newest filing. A backtest must
-- not read this; it needs the newest filing on or before its own date, which F2 adds as a function.
-- ---------------------------------------------------------------------------
create view public.sec_item_latest as
select distinct on (symbol, item, unit, period_start, period_end)
  symbol, item, kind, unit, period_start, period_end, is_instant, days, val, accn, form, fy, fp,
  filed, concept, priority
from public.sec_item_facts
order by symbol, item, unit, period_start, period_end, filed desc, accn desc;

comment on view public.sec_item_latest is
  'Per (symbol, item, unit, period) the value from the NEWEST filing - restatements win. The current '
  'view only: not point-in-time. Earlier filings remain in sec_item_facts / sec_facts.';

-- ---------------------------------------------------------------------------
-- sec_quarters: one value per fiscal quarter for flow and per-share items.
--
-- Bands, in days, wide enough for 52/53-week fiscal years (a 14-week quarter is 97 days):
--   quarter 75-105 | six months 165-200 | nine months 255-290 | year 350-380
-- A derived quarter is the difference between two consecutive year-to-date values that share a
-- start date, and must itself span 75-105 days - a gap in the filings produces no row rather than a
-- half-year labelled as a quarter.
-- ---------------------------------------------------------------------------
create view public.sec_quarters as
with src as (
  select *
  from public.sec_item_latest
  where kind in ('flow', 'per_share') and not is_instant
    and (days between 75 and 105 or days between 165 and 200 or days between 255 and 290 or days between 350 and 380)
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
  where days between 75 and 105
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
    and (period_end - prev_end) between 75 and 105
),
both_ as (
  select * from reported
  union all
  -- A reported quarter always wins over a derived one for the same quarter end.
  select d.* from derived d
  where not exists (
    select 1 from reported r
    where r.symbol = d.symbol and r.item = d.item and r.unit = d.unit and r.period_end = d.period_end
  )
)
select
  symbol, item, kind, unit, period_start, period_end, val, filed, accn, concept, derived,
  (derived and kind = 'per_share') as approximate
from both_;

comment on view public.sec_quarters is
  'One value per fiscal quarter for flow and per-share items: reported three-month values, else the '
  'difference of consecutive year-to-date values sharing a start (Q4 = FY - 9M, cash-flow quarters '
  'from YTD). derived says which; approximate marks per-share values obtained by differencing. Built '
  'on sec_item_latest, so it is the current view, not point-in-time. Decision 0059.';

-- ---------------------------------------------------------------------------
-- sec_coverage: what each company actually provides, per item. The check this layer exists to make
-- honest: a fundamental that is silently null for six names is worse than one never built.
-- ---------------------------------------------------------------------------
create view public.sec_coverage as
with items as (select distinct item, kind from public.sec_concept_map),
q as (
  select symbol, item, max(period_end) as last_quarter_end,
         count(*) filter (where period_end >= current_date - 400) as quarters_last_400d,
         string_agg(distinct concept, ', ') as concepts_used
  from public.sec_quarters group by symbol, item
),
i as (
  select symbol, item, max(period_end) as last_instant_end,
         string_agg(distinct concept, ', ') as concepts_used
  from public.sec_item_latest where is_instant group by symbol, item
)
select
  f.symbol, f.cik, f.last_form, f.last_filed, it.item, it.kind,
  coalesce(q.last_quarter_end, i.last_instant_end) as last_period_end,
  q.quarters_last_400d,
  coalesce(q.concepts_used, i.concepts_used) as concepts_used
from public.sec_filers f
cross join items it
left join q on q.symbol = f.symbol and q.item = it.item
left join i on i.symbol = f.symbol and i.item = it.item;

comment on view public.sec_coverage is
  'Per company and item: the newest period available and which tags supplied it. A null '
  'last_period_end means SEC companyfacts has nothing for that item for that company.';

grant select on public.sec_item_facts, public.sec_item_latest, public.sec_quarters, public.sec_coverage
  to service_role;

-- ---------------------------------------------------------------------------
-- SCHEDULE. Daily, two shards, after the 11:00 index catch-up.
--
--   11:20  swing-ingest-sec-a   fundamentals, shard 0/2
--   11:40  swing-ingest-sec-b   fundamentals, shard 1/2
--
-- Daily rather than weekly because a filing lands on no fixed day and a check costs one ~0.2 MB
-- request per company; only a company with a NEW periodic filing costs a companyfacts fetch. Every
-- day including weekends because SEC accepts filings until 22:00 ET and the morning run is when
-- Friday evening's arrive. Sharded, not offset - see provider.ts parseShard.
-- ---------------------------------------------------------------------------
select cron.unschedule(jobid) from cron.job
where jobname in ('swing-ingest-sec-a', 'swing-ingest-sec-b');

select cron.schedule(
  'swing-ingest-sec-a',
  '20 11 * * *',
  $job$
  select net.http_post(
    url     := 'https://qxngsbehqbcxnyyllalh.supabase.co/functions/v1/ingest?scope=fundamentals&shard=0/2&by=cron-sec',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                      where name = 'service_role_key'),
      'Content-Type', 'application/json'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $job$
);

select cron.schedule(
  'swing-ingest-sec-b',
  '40 11 * * *',
  $job$
  select net.http_post(
    url     := 'https://qxngsbehqbcxnyyllalh.supabase.co/functions/v1/ingest?scope=fundamentals&shard=1/2&by=cron-sec',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                      where name = 'service_role_key'),
      'Content-Type', 'application/json'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $job$
);
