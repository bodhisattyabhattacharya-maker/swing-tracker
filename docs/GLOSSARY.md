# Glossary

Shared vocabulary. Cheap file; it stops two people building two meanings for one word.

| Term | Means here |
|---|---|
| **Parameter** | One of the 26 tracked numbers. Computed on a schedule. Not a signal. |
| **Norm** | A threshold we define on a parameter that decides whether a cell gets coloured. Our judgment, stated explicitly. |
| **Rule** (Phase 2) | A named condition over one or more parameters that we want to be alerted on. |
| **Signal** | One firing of a rule on one ticker on one date. |
| **Episode** | A deduplicated run of consecutive signals. A rule firing 60 days straight is ~1 episode, not 60 — use episodes when judging sample size. |
| **Clock** | One of the four refresh schedules: hourly, daily, SEC-check, weekly. |
| **Baseline** | Buying any watchlist name on any random day over the test window. The bar a backtest must beat. |
| **Edge** | A rule's average forward return minus the baseline's, at the same horizon. |
| **Searched column** | A value obtained by Claude web search, not an API. Displayed with provenance; usable as a rule filter; never a trigger; not backtestable. |
| **Owner / viewer** | Owner can trigger refreshes and searches. Viewer reads only. Enforced by RLS. |
| **Completed week** | The last fully-closed weekly bar. All weekly parameters read this, never the current partial week. |
| **Warm-up floor** | The minimum bars before a recursive indicator stops reflecting its seed value. Below it, suppress the number rather than showing it. Floors are listed in `DEFINITIONS.md` §4 — **not** `CONSTRAINTS.md`, which is about the outside world. |
| **Golden value** | A known-correct figure for a specific ticker and date, committed as a test fixture. Catches the 'plausible but wrong' errors that invariant checks miss. |
| **Provider interface** | The contract every data source implements, so a paid feed can replace a free one without touching parameters, rules or the dashboard. |
| **Theme** | A ticker's peer group in `watchlist.yml`. Sector-relative ranks are computed within a theme, so a theme needs several members to mean anything. |
| **Hard stop** | An action requiring in-session confirmation every time — deploy, migration, external message, anything irreversible. Backed by `.claude/settings.json`, not just by asking. |
| **Tag** | A ticker's granular label in `watchlist.yml`, for display and filtering only. Never used in a calculation — that is what `theme` is for. |
| **Feature** | A stored column derived from bars — what a parameter is made of, or is. `daily_features` is the daily set. "Parameter" is the user-facing number on the grid; "feature" is the column it comes from, and for most of them they are the same thing. |
| **Seed-decay flag** | A boolean beside a recursive indicator (`rsi_daily_seed_ok`) saying whether it has cleared its warm-up floor. False means computed-but-still-partly-its-seed: show it if you must, never colour a cell on it. |
| **Invariant check** | A check phrased as "count the rows that violate this", so the expected answer is always zero. Preferred to checking an average, where a new violation can hide. |
| **MISSING** | A verify-script status distinct from both PASS and FAIL: the row the check needed does not exist, so nothing was verified. Never treat it as a pass — see `INCIDENTS.md` for why this project is blunt about it. |
