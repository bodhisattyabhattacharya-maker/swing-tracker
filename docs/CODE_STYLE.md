# Code style — write for the next agent

Most code here will be written by one Claude session and next read by a different one with no
memory of writing it. That inverts the usual economics of comments: **the reader is always a
stranger.** Optimise for the stranger.

One rule above the rest:

> **Comment the WHY, never the WHAT.** The code already says what it does. It cannot say why
> this way, what was tried first, or what breaks if you change it.

```sql
-- BAD: restates the code
-- calculate the 200 day simple moving average
avg(close) over (order by d rows between 199 preceding and current row) as sma200

-- GOOD: says what the reader cannot see
-- 200-bar SMA. `rows`, not `range`: range would silently widen the window across
-- market holidays and give a different number from TradingView. Null before 200
-- bars by design - a shorter average is a different statistic (see DEFINITIONS.md).
avg(close) over (order by d rows between 199 preceding and current row) as sma200
```

## Required headers

**Every migration** opens with a block stating purpose, dependencies and reversal. CI rejects a
migration without at least three comment lines at the top.

```sql
-- 20261003140000_weekly_features.sql
-- Purpose: roll daily bars into weekly, then compute weekly RSI / EMA / SMA positions.
-- Depends on: daily_bars (20260912120000), weekly_bars view (20261001090000).
-- Used by: the dashboard grid and every weekly norm in config/norms.yml.
-- Look-ahead: joins to the LAST COMPLETED week (week_start - 7). Do not "fix" this to the
--   current week - it would leak the rest of the week into every backtest.
-- Reversing: drop the view; no data loss, it is derived.
```

**A migration that creates a table must also grant on it.** Nothing is granted automatically —
see `CONSTRAINTS.md` 2026-09-13 and decision 0018. The ingest identity gets exactly what it
uses, and never `delete`:

```sql
grant select, insert, update on table weekly_features to service_role;
```

Before opening the PR, check the migration against this list: purpose header, grants for every
new table, RLS enabled, and — if the table is read by the dashboard — a policy, or an explicit
note saying reads come later.

**And after it merges, verify the STATE, not the operation.** A migration that applies cleanly
can still achieve nothing: `revoke execute ... from anon` succeeded while leaving the function
world-executable, because the real grant was to PUBLIC (INCIDENTS.md 2026-09-13). Query the
catalog — `pg_class.relacl`, `pg_proc.proacl`, `pg_default_acl` — and confirm the thing you
intended is true. "The migration applied" is not evidence.

**Every edge function** opens with inputs, outputs, failure modes and rate discipline.

```ts
/**
 * ingest-prices — fetch daily bars for the active watchlist.
 *
 * In:      ?range=5d|10y  ?symbols=MU,NVDA (default: all active tickers)
 * Out:     { ok, written, errors } and one row in ingest_runs
 * Source:  Yahoo v8/finance/chart. Unofficial and keyless - see CONSTRAINTS.md.
 * Fails:   a shape change returns 200 with an empty result, so we check for the
 *          timestamp array rather than trusting the status code.
 * Rate:    sequential, 4 at a time, 250ms between chunks. Be a polite guest.
 */
```

## Every parameter computation cites its definition

A number on the dashboard is only trustworthy if the reader can trace it. Name the parameter and
point at the spec:

```sql
-- Param 11: RSI(14) daily. Wilder smoothing (alpha = 1/14), NOT a rolling mean of
-- gains/losses - those differ by tens of RSI points and both get called "RSI".
-- Spec: docs/DEFINITIONS.md section 2. Golden value: MU 2026-09-04 = 60.146789.
```

If you change a formula, update `DEFINITIONS.md` **in the same commit**. A formula and its spec
drifting apart is how a dashboard starts quietly lying.

## Comment the traps, especially

Anywhere a reasonable person would "clean up" your code and break it, say so **in the code**.
The three live traps:

1. **The weekly join.** Looks like an off-by-one. Is not. It is what stops look-ahead bias.
2. **Wilder vs simple smoothing.** Looks interchangeable. Is not.
3. **`rows` vs `range` in window functions.** Looks equivalent on a dense series. Is not, across
   holidays and gaps.

## Naming

Use the words in `docs/GLOSSARY.md`. A `signal` is one firing; an `episode` is a deduplicated
run; a `norm` is a threshold; a `rule` is a named condition. Do not invent synonyms — two names
for one concept is how two people end up building two things.

Column and function names spell out the comparison: `close_vs_sma200d`, `pct_off_ath`,
`rs_vs_sox_6m`. Verbose beats ambiguous when the reader is a stranger.

## What not to do

- **No clever one-liners** in SQL. A nested window function nobody can read is a bug waiting for
  a deadline. Use a CTE with a name that explains itself.
- **No abstraction nobody asked for.** Two call sites is not a framework.
- **No silent fallbacks.** If data is missing, return null and let it surface. A quietly
  substituted default becomes a wrong number on a dashboard that looks right.
- **No magic numbers.** A threshold belongs in `config/norms.yml`. If a constant must live in
  code, comment where it came from.

## Tests encode intent

A test that passes against a hardcoded return value is worthless. Each test should fail if the
*business meaning* changes:

- **Golden values** — known-correct figures for a real ticker and date. Catches "plausible but
  wrong", which is the failure mode that actually happens here.
- **Invariants** — RSI within 0–100; a 200-bar SMA between the min and max of its own window;
  realized volatility non-negative.
- **Cross-implementation** — the same indicator computed a second way and asserted to agree.
