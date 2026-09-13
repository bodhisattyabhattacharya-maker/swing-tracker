-- 20260913230000_digest_changes.sql
-- Purpose:    what the email digest reports — which cells crossed a norm since the previous
--             trading day, and how many sit outside a norm in total.
-- Depends on: grid_cells (20260913190000).
-- Used by:    the `digest` edge function. Nothing reads it yet.
-- Grants:     select to service_role.
-- Reversing:  drop the two views. Nothing derived is lost.
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS A QUERY AND NOT A STORED LOG
--
-- "What changed today" is answerable because `grid_cells` holds every date, not just the latest
-- (decision 0002). Nothing has to be recorded at the moment of change, nothing can be missed by a
-- job that did not run, and the same query answers "what changed on any past day" by moving one
-- date filter. A change log written by the ingest would have been a second source of truth that
-- can silently disagree with the parameters it describes.
--
-- WHAT COUNTS AS A CROSSING, stated precisely because a digest that over-reports gets filtered
-- into a folder and never read again — the same failure as a staleness banner that cries wolf,
-- and harder to undo:
--
--   - Only cells that HAVE a norm. An unjudged parameter cannot cross anything.
--   - The verdict on the latest date must DIFFER from the verdict on that symbol's previous
--     stored date. Not from a fixed yesterday: a symbol that did not trade has no row, so
--     "previous stored date" is the honest comparison and it handles holidays for free.
--   - BOTH verdicts must be non-null. A value that has merely become judgeable — crossing its
--     warm-up floor — is not news about the market, and would otherwise announce itself once per
--     ticker per indicator forever. The cost of that choice: the first time a young name's RSI
--     becomes judgeable while already below 30, the digest stays quiet. Accepted, and written
--     down rather than discovered later.
--   - A value moving while staying inside the norm is NOT a crossing. The digest reports state
--     changes, not movement; the grid is where movement is read.
-- ---------------------------------------------------------------------------

create view public.digest_changes as
with judged as (
  -- Only normed cells, and only their own date sequence. Partitioning by (symbol, param) rather
  -- than filtering to two global dates is what makes this correct for a symbol that was halted,
  -- listed late, or simply missing a bar.
  select
    symbol, param, d, value, verdict,
    lag(verdict) over (partition by symbol, param order by d) as prev_verdict,
    lag(value)   over (partition by symbol, param order by d) as prev_value,
    lag(d)       over (partition by symbol, param order by d) as prev_d,
    row_number() over (partition by symbol, param order by d desc) as recency
  from public.grid_cells
  where has_norm
)
select
  j.symbol,
  j.param,
  j.d,
  j.prev_d,
  j.value,
  j.prev_value,
  j.prev_verdict,
  j.verdict,
  -- The direction of travel, which is what a reader actually wants in one glance. "left" means
  -- back inside the norm; there is no neutral word for it that is not longer than the sentence.
  case
    when j.prev_verdict = 'normal' and j.verdict = 'below' then 'crossed below'
    when j.prev_verdict = 'normal' and j.verdict = 'above' then 'crossed above'
    when j.prev_verdict in ('below', 'above') and j.verdict = 'normal' then 'back to normal'
    else j.prev_verdict || ' to ' || j.verdict
  end as movement,
  -- Whether this is something newly worth a look, or something calming down. Both belong in the
  -- digest: this tracker exists as much for taking profits as for entries, and a position coming
  -- back inside its norm is exactly the kind of thing that otherwise goes unnoticed.
  (j.verdict in ('below', 'above')) as now_outside
from judged j
where j.recency = 1
  and j.prev_verdict is not null
  and j.verdict is not null
  and j.verdict is distinct from j.prev_verdict;

comment on view public.digest_changes is
  'Cells whose norm verdict differs from the previous stored date for that symbol. Only normed '
  'cells, and only where both verdicts are non-null - a value crossing its warm-up floor is not '
  'news. Compares to the symbol''s own previous date, so holidays and halts need no special case.';

-- ---------------------------------------------------------------------------
-- The standing state, so the digest can say "and these are still out there".
--
-- A digest that only ever reports changes lets a name sit 45% below its high for three months
-- without ever being mentioned again after day one. That is the "rally we were never in" miss
-- that motivated this whole tool (PROPOSAL §1), so the standing count is not padding.
-- ---------------------------------------------------------------------------
create view public.digest_standing as
select
  c.symbol,
  c.param,
  c.value,
  c.verdict
from public.grid_cells c
where c.d = (select max(d) from public.grid_cells)
  and c.verdict in ('below', 'above');

comment on view public.digest_standing is
  'Every cell currently outside its norm, on the latest stored date. The digest reports changes '
  'against this backdrop so a long-standing condition does not vanish after the day it began.';

grant select on public.digest_changes, public.digest_standing to service_role;
