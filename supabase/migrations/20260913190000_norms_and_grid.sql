-- 20260913190000_norms_and_grid.sql
-- Purpose:    the layer the dashboard reads. Two config tables synced from yml, and two views:
--             `grid_cells` (one row per ticker/date/parameter, with its verdict) and
--             `grid_status` (one row: how fresh is this, and should the page say so).
-- Depends on: daily_features (20260913064000), tickers, ingest_runs.
-- Used by:    the Next.js grid. Nothing reads it yet.
-- Grants:     select to service_role only. The website reads server-side with service_role and
--             the browser never touches Postgres (v1 scope decision, 2026-09-13), so anon and
--             authenticated get nothing and RLS needs no read policy at all.
-- Reversing:  drop the two views, then the two tables. No derived data is lost - daily_features
--             is untouched and the config tables rebuild from the yml on the next sync.
--
-- WHY THE COMPARISON LIVES HERE AND NOT IN THE WEBSITE
--   A norm is the only opinion this product expresses - it is what turns a number into a coloured
--   cell. Three things will need that opinion: the grid, the email digest, and the Phase 2 rule
--   engine. Written in the website it would be written three times and drift. Written once here,
--   "was this cell red on 2024-03-12" is a WHERE clause over history, which is the same argument
--   as decision 0002 for parameters.
--
--   The cost, stated plainly: editing config/norms.yml no longer takes effect instantly. It takes
--   effect on the next sync. The sync runs daily and can be fired by hand, and norms.yml stays the
--   ONLY thing a human edits - this table is a cache of it, exactly like `tickers`.
--
-- WHY LONG FORMAT AND NOT A COLUMN PER PARAMETER
--   `grid_cells` returns one ROW per (symbol, date, parameter) rather than a wide row per ticker.
--   That way the verdict logic is one CASE expression instead of 26 near-identical ones, and
--   adding a parameter is one line in the unpivot rather than a new column plus a new verdict
--   column. The dashboard pivots in JavaScript, which is trivial. The cost is that the shape is
--   less obvious at a glance in psql - hence this comment.

-- ---------------------------------------------------------------------------
-- norms: a cache of the `norms:` block in config/norms.yml.
--
-- Both bounds are nullable and that is meaningful, not laziness. `pct_off_high_stored` has a low
-- bound only, because being far BELOW the high is the interesting state and there is no such
-- thing as being above it. `net_debt_ebitda` has a high bound only - it is a veto, not a band.
-- ---------------------------------------------------------------------------
create table public.norms (
  param      text primary key,
  low        double precision,
  high       double precision,
  source     text        not null default 'config/norms.yml',
  synced_at  timestamptz not null default now(),
  -- A norm with neither bound colours nothing and is almost certainly a typo in the yml.
  constraint norms_has_a_bound check (low is not null or high is not null),
  -- Caught at sync time rather than producing an empty band nobody notices.
  constraint norms_low_below_high check (low is null or high is null or low < high)
);
comment on table public.norms is
  'Cache of the norms: block in config/norms.yml. Overwritten by the sync; edit the yml, not this.';

-- ---------------------------------------------------------------------------
-- flags: the `flags:` block. Factual states, NOT judgments.
--
-- Kept in a separate table from norms because they are a different kind of thing and the
-- distinction is deliberate in the yml: a norm means "we have an opinion about this number", a
-- flag means "this number may not be trustworthy". The dashboard renders norms as colour and
-- flags as an icon with a label, never colour alone.
-- ---------------------------------------------------------------------------
create table public.flags (
  key        text primary key,
  value      jsonb       not null,
  source     text        not null default 'config/norms.yml',
  synced_at  timestamptz not null default now()
);
comment on table public.flags is
  'Cache of the flags: block in config/norms.yml. Factual states, rendered as icons - never colour.';

-- ---------------------------------------------------------------------------
-- grid_cells: every parameter that exists today, for every ticker and date, with its verdict.
--
-- Every date, not just the latest, per decision 0002 - so "show me the grid as it looked on any
-- past date" is a WHERE clause and a backtest reads the same view the dashboard does.
-- ---------------------------------------------------------------------------
create view public.grid_cells as
with cells as (
  select
    f.symbol,
    f.d,
    c.param,
    c.value,
    -- Whether this particular value has cleared its seed-decay floor. Only the two recursive
    -- indicators can fail it; everything else is true by construction, and saying so explicitly
    -- here is cheaper than a second CASE downstream.
    c.seed_ok,
    f.bars_available
  from public.daily_features f
  join public.tickers t on t.symbol = f.symbol
  cross join lateral (values
    -- param name                value                    seed_ok for THIS value
    ('close',                 f.close,                  true),
    ('rsi_daily',             f.rsi_daily,              f.rsi_daily_seed_ok),
    ('close_vs_sma50d',       f.close_vs_sma50d,        true),
    ('close_vs_sma200d',      f.close_vs_sma200d,       true),
    ('close_vs_ema21d',       f.close_vs_ema21d,        f.ema21_seed_ok),
    ('pct_off_high_stored',   f.pct_off_high_stored,    true),
    ('pct_above_low_stored',  f.pct_above_low_stored,   true),
    ('pct_off_52w_high',      f.pct_off_52w_high,       true),
    ('realized_vol_20',       f.realized_vol_20,        true),
    ('volume_ratio',          f.volume_ratio,           true)
  ) as c(param, value, seed_ok)
  -- Indices are market CONTEXT, never rows in the grid (watchlist.yml header). They are read by
  -- the market-context layer instead, which is a different shape entirely - one row per date.
  where t.active and not t.is_index
)
select
  cells.symbol,
  cells.d,
  cells.param,
  cells.value,
  n.low  as norm_low,
  n.high as norm_high,
  -- The verdict. Four distinct outcomes, and the difference between them is the whole point:
  --   null + no norm      -> we have no opinion about this number. Render it plain.
  --   null + below floor  -> the number exists but is still partly its own seed. Suppress it
  --                          (hard constraint 8) and let the flag explain why.
  --   'normal'            -> we DO have an opinion and this is inside it.
  --   'below' / 'above'   -> outside the norm, at the end that matters.
  -- Collapsing "no opinion" into "normal" would be the worst available bug here: it would paint
  -- twelve un-normed parameters as actively fine.
  case
    when cells.value is null      then null
    when not cells.seed_ok        then null
    when n.param is null          then null
    when n.low  is not null and cells.value < n.low  then 'below'
    when n.high is not null and cells.value > n.high then 'above'
    else 'normal'
  end as verdict,
  (n.param is not null)                        as has_norm,
  (cells.value is not null and not cells.seed_ok) as suppressed_warmup,
  cells.bars_available
from cells
left join public.norms n on n.param = cells.param;

comment on view public.grid_cells is
  'One row per (symbol, date, parameter) with its norm verdict. Long format on purpose - the '
  'comparison is one CASE, and adding a parameter is one line in the unpivot. verdict null means '
  'either no norm is defined or the value is suppressed for warm-up; has_norm and '
  'suppressed_warmup tell them apart. Indices excluded - they are market context, not grid rows.';

-- ---------------------------------------------------------------------------
-- grid_status: the freshness stamp and the staleness banner, as one row.
--
-- This is not decoration. v1 has one scheduled run a day, no retry, and no refresh button, so the
-- realistic failure is ten people reading silently stale numbers. The page must be unable to hide
-- that, which means the staleness judgment belongs next to the data rather than in the frontend.
--
-- `stale_days_price` comes from the flags table, so the threshold is edited in the yml like every
-- other judgment. The coalesce is a floor, not a default to rely on: if the flag is missing we
-- still want a working banner rather than a null that renders as "fresh".
-- ---------------------------------------------------------------------------
create view public.grid_status as
with f as (
  select coalesce((select (value #>> '{}')::int from public.flags where key = 'stale_days_price'), 3) as stale_days
),
d as (
  select
    max(d)                                   as data_through,
    count(distinct symbol)                   as symbols,
    (current_date - max(d))                  as days_behind
  from public.grid_cells
),
r as (
  select started_at, finished_at, ok, triggered_by
  from public.ingest_runs order by id desc limit 1
)
select
  d.data_through,
  d.symbols,
  d.days_behind,
  f.stale_days                       as stale_after_days,
  (d.days_behind > f.stale_days)     as is_stale,
  r.finished_at                      as last_run_at,
  r.ok                               as last_run_ok,
  r.triggered_by                     as last_run_by
from d cross join f left join r on true;

comment on view public.grid_status is
  'One row: how current the grid is and whether the page should say so. is_stale drives the '
  'banner; last_run_ok is NOT the same question - a run can succeed and still be a day behind.';

-- ---------------------------------------------------------------------------
-- Grants: explicit per decision 0018.
--
-- DELETE is granted here, which decision 0018 withholds everywhere else. The exception is
-- deliberate and narrow. 0018's reasoning was blast radius: `daily_bars` cascades from `tickers`,
-- so a delete there destroys years of history that cannot be re-fetched cheaply. These two tables
-- are caches of a file in a public git repo - the worst a wrong delete can do is blank the
-- verdicts until the next sync rebuilds them, and git holds the only real copy either way.
--
-- Delete is also genuinely REQUIRED, not convenient: a norm removed from the yml must stop
-- colouring its cell. `rs_vs_sox_6m` was removed exactly this way in decision 0019. The `tickers`
-- deactivate-never-delete pattern does not transfer, because a stale norm keeps silently painting
-- cells whereas a stale ticker merely sits inactive.
--
-- The compensating guard lives in the sync, not here: it refuses to write when the parsed yml
-- yields zero norms, so a truncated or failed fetch cannot wipe the table. That is the same
-- protection watchlist.ts already has for the opposite reason.
-- ---------------------------------------------------------------------------
grant select on public.grid_cells, public.grid_status to service_role;
grant select, insert, update, delete on public.norms, public.flags to service_role;
