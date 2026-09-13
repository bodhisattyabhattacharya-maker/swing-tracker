-- 20260913174500_daily_features_comment.sql
-- Purpose:    correct the COMMENT on daily_features. It says extremes cover "2 years on the free
--             plan"; as of 2026-09-13 we are on Stocks Starter and the window is 5 years
--             (decision 0021). Comment only - no data, no structure, no grants change.
-- Depends on: 20260913064000_daily_features.
-- Why a whole migration for a comment: `20260913064000_daily_features.sql` is merged, and a merged
--             migration is never edited (CODE_STYLE.md) - editing it would make the file disagree
--             with what actually ran. The comment is also not decoration: it is the database's own
--             answer to "what window do these extremes cover", readable from `psql \d+` and from
--             the dashboard's introspection, and a wrong answer there is worse than none. The
--             comment in the original migration file stays as-is; this is the live one.
-- Reversing:  restore the previous comment text. Nothing else is affected.

comment on materialized view public.daily_features is
  'Daily technical parameters per (symbol, date). Derived - rebuild with REFRESH MATERIALIZED '
  'VIEW public.daily_features. Extremes cover STORED history - 5 years on Stocks Starter since '
  '2026-09-13, and 2 years for any symbol not yet re-backfilled - never all time; INTC, QCOM and '
  'GE peaked in 2000, outside every tier we would buy. Index symbols have no OHLC or volume, so '
  'those columns are null for them. A recursive indicator whose *_seed_ok flag is false is still '
  'partly its own seed - suppress it rather than colour a cell on it (hard constraint 8). '
  'Formulas: DEFINITIONS.md sections 1-4.';
