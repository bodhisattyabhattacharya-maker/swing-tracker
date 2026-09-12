-- 20260912120000_foundation.sql
-- Purpose:    extensions, the watchlist cache, raw bar tables, and ingest observability.
--             Nothing derived lives here. Parameters arrive in later migrations as views.
-- Depends on: nothing. This is the first migration.
-- Used by:    every ingest function (writes) and every parameter view (reads).
-- Security:   the project auto-enables RLS on new tables (ensure_rls event trigger), but we
--             write `enable row level security` explicitly anyway so intent survives a
--             project recreate. We also revoke the default anon/authenticated privileges so
--             a table is unreachable until a migration grants access on purpose - the repo
--             is public, so the schema is public, so deny-by-default is the only safe start.
-- Reversing:  drop tables in reverse order. Extensions can stay.
-- Naming:     Supabase CLI / GitHub-integration format is <YYYYMMDDHHMMSS>_<name>.sql.
--             Timestamps sort, so "numbered, forward-only" still holds (decision 0016).

-- ---------------------------------------------------------------------------
-- Extensions. pg_net gives Postgres outbound HTTP (how we reach Yahoo and the
-- SEC from inside Supabase - see CLAUDE.md constraint 1). pg_cron schedules it.
-- ---------------------------------------------------------------------------
create extension if not exists pg_net  with schema extensions;
create extension if not exists pg_cron;

-- ---------------------------------------------------------------------------
-- Turn OFF "automatically expose new tables". Without this, every new table is
-- readable by the anon role by default (RLS still gates rows, but this removes
-- the privilege entirely until a migration grants it deliberately).
-- ---------------------------------------------------------------------------
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

-- ---------------------------------------------------------------------------
-- tickers: a CACHE of config/watchlist.yml, not the source of truth.
-- The nightly ingest re-reads the yml from the public repo and upserts here, so
-- editing this table by hand is pointless - it will be overwritten. Edit the yml.
-- ---------------------------------------------------------------------------
create table tickers (
  symbol      text primary key,
  name        text        not null,
  theme       text        not null,   -- coarse peer group; drives sector-relative ranks
  tag         text,                   -- granular label; display only, never computed on
  bellwether  boolean     not null default false,
  rankable    boolean     not null default true,   -- false => sector ranks return null
  is_index    boolean     not null default false,  -- ^VIX etc: context, never in the grid
  active      boolean     not null default true,
  source      text        not null default 'config/watchlist.yml',
  synced_at   timestamptz not null default now()
);
comment on table tickers is
  'Cache of config/watchlist.yml. Overwritten by the nightly sync; edit the yml, not this.';

-- ---------------------------------------------------------------------------
-- daily_bars: full OHLCV, one row per symbol per trading day. Adjusted close is
-- kept alongside the raw close because "% off all-time high" compares against
-- an adjusted series (DEFINITIONS.md, "Price behaviour").
-- `source` on every row is what makes swapping providers auditable (decision 0003).
-- ---------------------------------------------------------------------------
create table daily_bars (
  symbol      text        not null references tickers(symbol) on delete cascade,
  d           date        not null,
  open        double precision,
  high        double precision,
  low         double precision,
  close       double precision not null,
  adj_close   double precision,
  volume      bigint,
  source      text        not null,
  ingested_at timestamptz not null default now(),
  primary key (symbol, d)
);
create index daily_bars_d_idx on daily_bars (d);

-- ---------------------------------------------------------------------------
-- hourly_bars: two years of hourly OHLCV. Feeds hourly RSI only (param 10).
-- Timestamps are bar OPEN times in UTC; Yahoo returns them that way.
-- ---------------------------------------------------------------------------
create table hourly_bars (
  symbol      text        not null references tickers(symbol) on delete cascade,
  ts          timestamptz not null,
  open        double precision,
  high        double precision,
  low         double precision,
  close       double precision not null,
  volume      bigint,
  source      text        not null,
  ingested_at timestamptz not null default now(),
  primary key (symbol, ts)
);
create index hourly_bars_ts_idx on hourly_bars (ts);

-- ---------------------------------------------------------------------------
-- ingest_runs: one row per run of any fetcher. This is how a failure becomes
-- visible instead of silent, and how a "Refresh now" spike is traceable to a
-- person (PROPOSAL.md, "Refresh triggers"). `detail` holds per-symbol counts
-- and error text.
-- ---------------------------------------------------------------------------
create table ingest_runs (
  id            bigint generated always as identity primary key,
  source        text        not null,   -- e.g. yahoo-daily, yahoo-hourly, sec-xbrl
  scope         text        not null,   -- e.g. prices, fundamentals, searches
  triggered_by  text        not null default 'schedule',  -- 'schedule' or a user id
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  ok            boolean,
  rows_written  integer     not null default 0,
  detail        jsonb
);
create index ingest_runs_started_idx on ingest_runs (started_at desc);

-- ---------------------------------------------------------------------------
-- Row-level security on everything. No policies yet: deny by default.
-- The service role (used by edge functions) bypasses RLS, so ingest still works.
-- Read policies for the dashboard arrive with the first parameter views.
-- ---------------------------------------------------------------------------
alter table tickers      enable row level security;
alter table daily_bars   enable row level security;
alter table hourly_bars  enable row level security;
alter table ingest_runs  enable row level security;
