---
name: add-ticker
description: Add or remove a ticker from the watchlist. Use when asked to add, drop, or swap a symbol, or to change a ticker's theme.
---

# Add a ticker

1. Edit `config/watchlist.yml` only. Never insert directly into the database — the file is the
   source of truth and a direct insert will be overwritten.
2. Set `theme` to an existing value if one fits. Sector-relative ranks are computed within a
   theme, so a theme with one member produces a meaningless rank.
3. Commit on a branch and open a PR. The nightly run backfills history on merge.
4. Check the warm-up floors in `docs/CONSTRAINTS.md`. A newly listed name may not have enough
   bars for the weekly 21 EMA (97 weekly bars) — if so, note it in the PR so nobody trusts that
   column for it yet.
5. Removing a ticker: delete the line. Leave its stored bars alone — history costs nothing and
   deleting it breaks any backtest that referenced it.
