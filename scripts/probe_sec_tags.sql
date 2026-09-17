-- scripts/probe_sec_tags.sql
--
-- THE FIRST OF THE TWO MEASUREMENTS `docs/DEFINITIONS.md` §7 says must happen before any
-- fundamental is built: **do our 36 filers actually report the tags the definitions assume?**
--
-- §7 settled the formulas. It did not settle whether the data exists, and a fundamental that
-- silently goes null for six of the watchlist is worse than one that was never built. This script
-- asks SEC directly instead of assuming.
--
-- RUN IT IN THE SUPABASE SQL EDITOR, one STEP at a time. It is not run by CI and never will be:
-- it makes outbound requests, and CI has no business doing that. It is committed because the answer
-- has a shelf life — filers change tags — and the next person to ask should re-run it rather than
-- trust a number in a doc.
--
-- WHY NOT FROM AN AGENT SESSION: the read-only SQL connection cannot queue a pg_net request (it is
-- an INSERT), and applying a migration to get around that is a hard stop. So a human runs the
-- fetch and the agent reads the rows back. That division is deliberate.
--
-- ---------------------------------------------------------------------------
-- WHAT WE ALREADY EXPECT TO FIND, written down BEFORE running so the result can contradict it
--
-- 1. **Three filers report no `us-gaap` facts at all.** TSM, ASML and ARM are foreign private
--    issuers filing 20-F under IFRS; in SEC XBRL their facts sit under `ifrs-full`. If that holds,
--    every fundamental in §7 is null for 8% of the watchlist — and not a marginal 8%: it is the
--    foundry and lithography core of a semiconductor list. **This is a hypothesis, not a fact,
--    until STEP 3 prints it.**
-- 2. **The capitalised-software tag varies by filer.** §7 #4 chose "PP&E + capitalised software"
--    without naming the tag, because there is no single one. STEP 4 DISCOVERS what each filer
--    actually uses rather than guessing a name and reading a null as an absence.
-- 3. **SNDK has almost no history.** Recently separated from WDC, so a TTM figure needs four
--    quarters it may not have filed yet.
--
-- ---------------------------------------------------------------------------
-- COST CONTROL: this runs on a SAMPLE first, on purpose.
--
-- `companyfacts` returns every fact a filer has ever reported — megabytes for a mega-cap. Pulling
-- 36 of those into `net._http_response` could be hundreds of megabytes on a small instance. STEP 3
-- does SIX and prints the payload sizes; only then is it sensible to decide whether to do the rest
-- this way or switch to the small per-tag `companyconcept` endpoint.
--
-- Measure, then commit. Same rule as everywhere else in this repo.
--
-- ETIQUETTE: SEC's fair-access policy asks for a declared User-Agent and allows 10 requests/second.
-- The agent below identifies the project and carries **no personal contact details** — if SEC
-- refuses it, that is a decision for a human about what address to publish, not something to work
-- around by removing the header.
-- ---------------------------------------------------------------------------


-- ===========================================================================
-- STEP 1 — the ticker → CIK map. One request, about 1 MB.
-- Run this, then wait a few seconds before STEP 2.
-- ===========================================================================

select net.http_get(
  url     := 'https://www.sec.gov/files/company_tickers.json',
  headers := '{"User-Agent": "swing-tracker/1.0 (parameter definition check)", "Accept": "application/json"}'::jsonb,
  timeout_milliseconds := 20000
) as request_id;


-- ===========================================================================
-- STEP 2 — did it arrive, and does every one of our 36 names resolve to a CIK?
--
-- A symbol that does not resolve is the first finding, not a retry: it means the ticker SEC knows
-- differs from the one in config/watchlist.yml, and every fundamental for that name would be null
-- with nothing saying why.
-- ===========================================================================

with resp as (
  select (content)::jsonb as body, status_code, octet_length(content) as bytes
  from net._http_response
  where id = (select max(id) from net._http_response)
),
map as (
  select upper(e.value->>'ticker') as symbol,
         lpad((e.value->>'cik_str'), 10, '0') as cik
  from resp, jsonb_each((select body from resp)) e
)
select
  t.symbol,
  m.cik,
  case when m.cik is null then 'NOT FOUND AT SEC - check the ticker in watchlist.yml' else 'ok' end as status
from public.tickers t
left join map m on m.symbol = t.symbol
where t.active and not t.is_index
order by (m.cik is null) desc, t.symbol;


-- ===========================================================================
-- STEP 3 — companyfacts for a SIX-NAME SAMPLE, chosen to span the failure modes.
--
--   AVGO  a complex US mega-cap, the shape most tags are designed around
--   ALAB  listed 2024 - short history, the young-filer case
--   TSM   foreign private issuer, IFRS - the hypothesis above
--   ASML  the same, a different jurisdiction, to see whether it fails the same way
--   MSFT  the heaviest capitaliser of software on the list
--   SNDK  recently separated from WDC - the almost-no-history case
--
-- Run STEP 2 first; this reuses its map. Wait ~10 seconds before STEP 4.
-- ===========================================================================

with resp as (
  select (content)::jsonb as body
  from net._http_response
  where id = (select max(id) from net._http_response where status_code = 200)
),
map as (
  select upper(e.value->>'ticker') as symbol,
         lpad((e.value->>'cik_str'), 10, '0') as cik
  from resp, jsonb_each((select body from resp)) e
)
select m.symbol, m.cik,
       net.http_get(
         url     := 'https://data.sec.gov/api/xbrl/companyfacts/CIK' || m.cik || '.json',
         headers := '{"User-Agent": "swing-tracker/1.0 (parameter definition check)", "Accept": "application/json"}'::jsonb,
         timeout_milliseconds := 30000
       ) as request_id
from map m
where m.symbol in ('AVGO','ALAB','TSM','ASML','MSFT','SNDK');


-- ===========================================================================
-- STEP 4 — the answer. One row per (symbol, tag): is it there, and how deep is the history?
--
-- `taxonomies` is the discovery half: it prints which taxonomies each filer actually uses, which is
-- what settles the IFRS hypothesis. `software_tags` is the other discovery half - every tag whose
-- name mentions software, so §7 #4 can name a real tag instead of a guessed one.
--
-- PAYLOAD SIZES ARE PRINTED DELIBERATELY. They decide whether the remaining 30 names go through
-- this endpoint or through the small per-tag `companyconcept` one.
-- ===========================================================================

with facts as (
  select
    substring(url from 'CIK([0-9]{10})\.json') as cik,
    octet_length(content)                      as bytes,
    (content)::jsonb                           as body
  from net._http_response
  where url like '%/companyfacts/CIK%' and status_code = 200
),
named as (
  select t.symbol, f.cik, f.bytes, f.body
  from facts f
  join public.tickers t on t.symbol = coalesce(
        (select upper(e.value->>'ticker')
           from net._http_response r, jsonb_each((r.content)::jsonb) e
          where r.url like '%company_tickers.json%' and r.status_code = 200
            and lpad((e.value->>'cik_str'), 10, '0') = f.cik
          limit 1), '')
),
tags(taxonomy, tag, what) as (values
  ('us-gaap','GrossProfit','gross margin - step 8 sector rank'),
  ('us-gaap','Revenues','revenue, EV/Sales'),
  ('us-gaap','RevenueFromContractWithCustomerExcludingAssessedTax','revenue, the ASC 606 spelling'),
  ('us-gaap','OperatingIncomeLoss','EBITDA and NOPAT'),
  ('us-gaap','DepreciationDepletionAndAmortization','EBITDA'),
  ('us-gaap','EarningsPerShareDiluted','trailing P/E'),
  ('us-gaap','NetCashProvidedByUsedInOperatingActivities','FCF numerator'),
  ('us-gaap','PaymentsToAcquirePropertyPlantAndEquipment','capex, core'),
  ('us-gaap','OperatingLeaseLiabilityCurrent','leases as debt - 0040'),
  ('us-gaap','OperatingLeaseLiabilityNoncurrent','leases as debt - 0040'),
  ('us-gaap','CashAndCashEquivalentsAtCarryingValue','net debt, EV'),
  ('us-gaap','ShortTermInvestments','net debt - load-bearing for the mega-caps'),
  ('us-gaap','StockholdersEquity','invested capital'),
  ('us-gaap','IncomeTaxExpenseBenefit','effective tax rate for NOPAT'),
  ('dei','EntityCommonStockSharesOutstanding','share count change')
)
select
  n.symbol,
  round(n.bytes / 1024.0 / 1024.0, 2) as payload_mb,
  g.tag,
  (n.body->'facts'->g.taxonomy ? g.tag) as present,
  coalesce(jsonb_array_length(
    coalesce(n.body->'facts'->g.taxonomy->g.tag->'units'->'USD',
             n.body->'facts'->g.taxonomy->g.tag->'units'->'shares')), 0) as observations,
  g.what
from named n cross join tags g
order by n.symbol, (n.body->'facts'->g.taxonomy ? g.tag), g.tag;


-- --- STEP 4b: which taxonomies does each filer use? This settles the IFRS hypothesis. -----------
with facts as (
  select substring(url from 'CIK([0-9]{10})\.json') as cik,
         (content)::jsonb as body
  from net._http_response
  where url like '%/companyfacts/CIK%' and status_code = 200
)
select body->>'entityName' as filer,
       cik,
       (select string_agg(k, ', ' order by k) from jsonb_object_keys(body->'facts') k) as taxonomies,
       (select count(*) from jsonb_object_keys(coalesce(body->'facts'->'us-gaap','{}'::jsonb)) k) as us_gaap_tag_count
from facts
order by 1;


-- --- STEP 4c: what does each filer call capitalised software? DISCOVERY, not a guess. -----------
with facts as (
  select substring(url from 'CIK([0-9]{10})\.json') as cik,
         (content)::jsonb as body
  from net._http_response
  where url like '%/companyfacts/CIK%' and status_code = 200
)
select f.body->>'entityName' as filer, k as tag
from facts f, jsonb_object_keys(coalesce(f.body->'facts'->'us-gaap','{}'::jsonb)) k
where k ilike '%software%'
order by 1, 2;
