-- 20260916140000_rs_cells.sql
-- Purpose:    give relative strength AND the market block the same cell shape every other parameter
--             has, so the grid colours them from the database rather than recomputing verdicts in
--             the page. Adds `rs_cells` and `market_cells`.
-- Depends on: relative_strength and market_context (20260915140000, 20260915130000),
--             norms (20260913190000), tickers.
-- Grants:     select on rs_cells and market_cells to service_role.
-- Reversing:  drop view public.rs_cells; drop view public.market_cells. Nothing else is touched -
--             no data, no matviews, and both source views are left exactly as they were.
--
-- ---------------------------------------------------------------------------
-- WHY A VIEW RATHER THAN THREE MORE COLUMNS IN grid_cells
--
-- `grid_cells` is keyed on (symbol, DAY) and every row in it is valid for that day.
-- `relative_strength` publishes rows only on dates where BOTH legs have a bar, and SPX arrives from
-- FRED hours after the equities do - so on the evening of a trading day the newest RS date is one
-- session behind the newest equity date. Joining RS into `grid_cells` would mean one of two things
-- and both are wrong:
--
--   an inner join   the whole grid loses its newest day every evening, because grid_cells is read
--                   at a single date and that date would have no RS rows.
--   an as-of join   a value from an earlier session sitting in a row labelled today, with nothing
--                   on it saying so - and, measured in decision 0035, a band join that takes an
--                   unfiltered read of the view from 441 ms to 8,826 ms. That is the same defect
--                   this week's outage was, re-introduced one migration after fixing it.
--
-- So RS keeps its own view, with its own `d`, and the PAGE reads it at ITS newest date and labels
-- that date wherever it differs from the grid's. Every borrowed value carries its own date
-- (decision 0034); here the date is carried by the row rather than by an extra column.
--
-- WHAT THIS VIEW IS FOR, precisely: the verdict. `grid_cells` decides below/normal/above with a
-- CASE over the norms join, and that decision belongs in exactly one place. Without this view the
-- page would have to re-implement it in TypeScript against the same norms table - two copies of a
-- rule that decides what colour a cell is, which is the kind of drift nobody notices until a cell
-- is the wrong colour. The CASE below is a copy of the one in grid_cells, and it is a copy on
-- purpose rather than a shared function: a scalar function per cell is a per-row call the planner
-- cannot inline through, and these two are asserted equal by scripts/ci/check_formulas.sql.
--
-- NO WARM-UP FLAG, and `seed_ok` is therefore absent rather than hard-coded true. RS is a ratio of
-- two closes: below n bars `lag` returns null and the value is null. There is nothing that is
-- "computed but not yet trustworthy", so `suppressed_warmup` is false for every row here - not as
-- a simplification, but because the state it describes cannot occur (decision 0035).
--
-- ALL THREE WINDOWS ARE PUBLISHED, though only 126b gets a column today. The others cost nothing -
-- they are already computed - and having them here means adding a column later is one line in
-- web/lib/grid.ts rather than a migration. They ship with `has_norm = false`, which is the state
-- twelve other parameters are already in and which the grid already renders correctly.
--
-- PARAM NAMES MATCH THE NORM KEYS, which is the whole point of yesterday's rename. `rs_vs_spx_126b`
-- here is `rs_vs_spx_126b` in config/norms.yml. The old `rs_vs_spx_6m` would have matched nothing
-- and coloured nothing, silently - norms are joined BY NAME (decision 0038).
-- ---------------------------------------------------------------------------

create view public.rs_cells as
with cells as (
  select r.symbol, r.d, c.param, c.value
  from public.relative_strength r
  join public.tickers t on t.symbol = r.symbol and t.active and not t.is_index
  cross join lateral ( values
      ('rs_vs_spx_63b'::text,  r.rs_63b),
      ('rs_vs_spx_126b'::text, r.rs_126b),
      ('rs_vs_spx_252b'::text, r.rs_252b)
    ) c(param, value)
)
select
  cells.symbol,
  cells.d,
  cells.param,
  cells.value,
  n.low  as norm_low,
  n.high as norm_high,
  -- Copied from grid_cells, minus the seed_ok arm, which has no meaning here. Keep them in step:
  -- check_formulas.sql asserts that the same (value, low, high) produces the same verdict in both.
  case
    when cells.value is null then null::text
    when n.param is null     then null::text
    when n.low  is not null and cells.value < n.low  then 'below'::text
    when n.high is not null and cells.value > n.high then 'above'::text
    else 'normal'::text
  end as verdict,
  n.param is not null as has_norm,
  -- Always false, and present so the page can read rs_cells and grid_cells with one code path.
  false as suppressed_warmup
from cells
left join public.norms n on n.param = cells.param;

comment on view public.rs_cells is
  'Relative strength in the same cell shape as grid_cells - one row per (symbol, day, param) with '
  'the verdict decided here rather than in the page. Kept separate from grid_cells because RS exists '
  'only on dates where SPX also has a bar, which is one session behind the equities most evenings; '
  'the reader takes the newest d and labels it. suppressed_warmup is always false: RS has no seed. '
  'See 20260916140000 and decision 0035.';

grant select on public.rs_cells to service_role;

-- ---------------------------------------------------------------------------
-- market_cells: the market block, in the same cell shape, for the same reason.
--
-- `market_context` publishes raw numbers and their as-of dates; two of them have norms and should be
-- coloured. Without this view the page would compute those two verdicts in TypeScript - a THIRD copy
-- of the rule that decides a cell's colour. One copy in SQL that the CI parity check already covers
-- is cheaper than a copy in a language the check cannot reach.
--
-- KEYED ON d, NOT ON (symbol, d), because the market is not a symbol. Resisting the temptation to
-- give it a fake symbol like '^MKT' so it could live in grid_cells: every per-symbol query, every
-- breadth count and every `count(distinct symbol)` would then have to remember to exclude it, and
-- one that forgot would be wrong in a way nobody would see.
--
-- EACH VALUE CARRIES ITS OWN as_of, which is decision 0034 restated. VIX comes from FRED and lags
-- the equities by a session most evenings; SPX lags too, and by a different amount on the day one
-- publishes and the other does not. A block that showed four numbers under one date would be
-- claiming something it cannot know. `term_structure` borrows `vix_as_of` deliberately - the view
-- only computes it when both VIX legs are from the SAME day, so there is exactly one date to carry.
--
-- `breadth_pct` is as of `d` itself: it is counted from the equities, which are what `d` is.
-- ---------------------------------------------------------------------------
create view public.market_cells as
with cells as (
  select m.d, c.param, c.value, c.as_of
  from public.market_context m
  cross join lateral ( values
      ('vix'::text,             m.vix,                        m.vix_as_of),
      ('term_structure'::text,  m.term_structure,             m.vix_as_of),
      ('spx_close'::text,       m.spx_close,                  m.spx_as_of),
      ('breadth_pct'::text,     m.breadth_pct::double precision, m.d)
    ) c(param, value, as_of)
)
select
  cells.d,
  cells.param,
  cells.value,
  cells.as_of,
  n.low  as norm_low,
  n.high as norm_high,
  case
    when cells.value is null then null::text
    when n.param is null     then null::text
    when n.low  is not null and cells.value < n.low  then 'below'::text
    when n.high is not null and cells.value > n.high then 'above'::text
    else 'normal'::text
  end as verdict,
  n.param is not null as has_norm,
  false as suppressed_warmup
from cells
left join public.norms n on n.param = cells.param;

comment on view public.market_cells is
  'The market block as cells - one row per (day, param) with the verdict decided here rather than in '
  'the page, so the colour rule exists once. Keyed on d alone: the market is not a symbol, and giving '
  'it a fake one would put it in every per-symbol count. as_of is per PARAM, because VIX and SPX '
  'arrive from FRED on different days - decision 0034. See 20260916140000.';

grant select on public.market_cells to service_role;

-- ---------------------------------------------------------------------------
-- A NORM RENAME THIS VIEW DEPENDS ON, recorded here because this is where it bites.
--
-- `term_structure` above joins norms BY NAME. The norm was called `vix_term_struct`, which matches
-- no column anywhere and therefore judged nothing at all - the same silent no-op the RS norm was in
-- until yesterday, and the third instance this week of a norm named for an idea rather than for the
-- parameter it judges. Renamed to `term_structure` in config/norms.yml.
--
-- Norms reach the database through the ingest's norms sync, which runs on the `tickers` and `all`
-- scopes. So this view ships with `term_structure` uncoloured until the 22:30 UTC run, and then it
-- colours. That is not a bug to chase at 18:00; `has_norm = false` is a state the page already
-- renders correctly, and the row arrives with the evening's sync.
-- ---------------------------------------------------------------------------
