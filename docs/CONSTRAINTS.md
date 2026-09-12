# Constraints

Discovered facts about the outside world. **Not** choices — see `DECISIONS.md` for those.
These expire: anything older than 90 days gets re-verified.
Dead ends that burned two or more attempts also belong here.

| Verified | Fact |
|---|---|
| 2026-08-17 | **No market-data egress from AI coding sandboxes.** Yahoo, Stooq, Alpha Vantage, Polygon, Tiingo, FMP and Nasdaq all fail at the proxy; only package registries resolve. Fetching must live in Supabase. |
| 2026-08-17 | **Stooq is unusable** — sits behind a JavaScript bot-check that returns an HTML challenge page, not CSV. |
| 2026-08-17 | **Yahoo `quoteSummary` + `v7/quote` return 401 "Invalid Crumb"** from a server. No keyless forward P/E, PEG, consensus, targets, margins, short interest or institutional holdings. |
| 2026-08-17 | **Yahoo `v8/finance/chart` works keyless** from Supabase. Daily and `range=max` (quarterly candles, real highs/lows, back to first trade — 1984 MU, 1980 INTC). |
| 2026-09-05 | **Yahoo hourly gives 2 years**, ~3,500 bars per ticker, `dataGranularity: "1h"`. An earlier note claiming a 3-month cap was wrong. |
| 2026-08-17 | **SEC XBRL works keyless** (`data.sec.gov`), stamped with filing dates. Needs a descriptive User-Agent with contact email. Published rate limit: 10 requests/second. |
| 2026-09-05 | **`^VIX3M` is free and live** on the chart endpoint — term structure costs nothing extra. |
| 2026-09-05 | **Yahoo's `range=max` series and the daily series agree on basis** (both split/dividend adjusted). MU all-time high = $1,255.00 from both. Safe to mix. |
| 2026-09-05 | **Warm-up floors.** Seed influence drops below 0.01% after: RMA(14) 125 bars, EMA(21) 97, EMA(50) 231, EMA(200) 922. Below these, suppress the value. |
| 2026-09-05 | **SNDK has only 82 weekly bars** (spun off from WDC 2025-02-13) — its weekly 21 EMA is seed-sensitive until roughly March 2027. |
| 2026-09-12 | **GitHub Free does not support protected branches on private repos** — public repos only, or any repo on Pro. Drove the decision to go public. |
| 2026-09-12 | **The prototype Supabase project sits in a Vercel-managed org**, where member invites flow through Vercel rather than Supabase team settings. The real project should live in a self-owned Supabase org. |
| 2026-09-12 | **Git is unusable inside the Cowork device VM.** That shell cannot delete files, so git cannot remove `.git/index.lock` or its temp objects — the repo wedges after the first `git add`. Run git natively (GitHub Desktop or the Mac terminal), not through the device shell. |
