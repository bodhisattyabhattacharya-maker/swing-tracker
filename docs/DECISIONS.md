# Decisions

Append-only. Newest last. Each entry: what we decided, why, what we rejected.
Written **before** building. For what got built, see `FEATURES.md`.

---

## 0001 — 2026-09-12 — Supabase is the data plane, not just storage
**Decided:** all market-data fetching runs inside Supabase (edge functions / pg_net), with
signals computed as SQL. **Why:** AI coding sandboxes have no network route to any market-data
provider; Supabase's network does. **Rejected:** fetch scripts running where we write code
(fails at the proxy), and a separate worker service (more infrastructure for no gain).

## 0002 — 2026-09-12 — Rules and norms are data, not code
**Decided:** setups and colour thresholds live as JSON/YAML rows, evaluated by an engine that is
a pure function of `(ticker, date)`. **Why:** makes backtesting free — replay is the same code
with the date argument opened up — and lets us tune thresholds without a deploy.
**Rejected:** imperative rule logic, which would need a second implementation for replay.

## 0003 — 2026-09-12 — No paid data feed in v1
**Decided:** keyless sources only (Yahoo chart + SEC XBRL), with analyst figures via Claude web
search. **Why:** free, and SEC gives genuinely point-in-time fundamentals. **Rejected:** a paid
estimates feed (~$30–80/mo) — revisit once we know whether we actually read the searched column.
**Mitigation:** a provider interface so a paid feed drops in without touching anything downstream.

## 0004 — 2026-09-12 — No score and no ranking in v1
**Decided:** colour against norms we define; no composite score, no ordering.
**Why:** a ranking implies an edge we have not proven. **Rejected:** a weighted score — deferred
until we have watched real data for a few weeks.

## 0005 — 2026-09-12 — Desktop-first, with an email digest as the phone surface
**Decided:** full grid on desktop web; a daily email digest for the phone; a deliberately thin
mobile view for checking one name. **Why:** 26 columns across 36 names is an information-density
problem no responsive layout solves. **Rejected:** a PWA (only pays off if the phone is a
scanning surface, which it isn't) and Slack (adds a workspace dependency; email is archivable).

## 0006 — 2026-09-12 — Extremes measured on intraday highs and lows
**Decided:** all-time and 52-week extremes use true highs/lows, not closes. **Why:** the
all-time high is the highest price actually traded; for MU that is $1,255.00 vs $1,213.56 on
closes. **Rejected:** close-based extremes, which understate every "% off high" threshold.

## 0007 — 2026-09-12 — Technicals anchored to TradingView
**Decided:** match TradingView's Pine definitions exactly for RSI, EMA and SMA; define
realized volatility and relative strength ourselves and say so. For fundamentals, match
ourselves consistently and note the divergence. **Why:** TradingView publishes its formulas, so
they are reproducible; consumer apps buy adjusted vendor fundamentals we cannot reproduce.
**Rejected:** chasing Robinhood's fundamentals, which use non-GAAP earnings.

## 0008 — 2026-09-12 — Public GitHub repo
**Decided:** public repo on GitHub Free. **Why:** protected branches, unlimited Actions minutes
and free secret-scanning push protection are all free on public repos and paid on private ones.
**Rejected:** private on Free (no branch protection — the harness could not enforce anything)
and GitHub Pro (revisit if we want privacy later). **Accepted risk:** going private later does
not unpublish history, so secret discipline is non-negotiable from the first commit.

## 0009 — 2026-09-12 — The prototype is reference-only; this repo rebuilds clean
**Decided:** the throwaway Supabase project keeps running as a reference, but this repo rebuilds
from numbered migrations. **Carries over:** the verified indicator formulas and golden values
(`DEFINITIONS.md`), and everything in `CONSTRAINTS.md`. **Does not carry over:** the prototype's
ad-hoc SQL, its 20 draft rules, and its Vercel-managed Supabase org.
**Why:** the prototype's schema grew by accretion with no migration history, and a look-ahead bug
in its weekly join was only caught late — it is not a base to build on. Its org also cannot
cleanly invite a collaborator.
**Rejected:** porting the prototype SQL wholesale, which would import both the accretion and the
habit that produced the look-ahead bug.

## 0010 — 2026-09-12 — PROPOSAL is the frozen spec; FEATURES is the record of what exists
**Decided:** `PROPOSAL.md` is edited only when **scope** changes. What actually got built, and
how, is recorded in `FEATURES.md`. **Why:** both documents otherwise end up describing the same
system, drift apart, and nobody knows which is true. **Rejected:** keeping the proposal current
as living documentation — that makes it a second, competing description of the codebase.
**Practical rule:** if a PR changes what the product *is*, update the proposal. If it changes
what *exists*, update FEATURES.

## 0011 — 2026-09-12 — Coarse `theme` for ranking, granular `tag` for display
**Decided:** seven themes sized 4–7 members, plus a `tag` field used only for display. Themes
that are not genuine peer groups (`diversified`, `foundry-analog-ip`) carry `rankable: false` and
return **null** for sector-relative ranks. **Why:** the original 25 themes left 16 singletons, so
sector-relative rank was meaningless for 32 of 36 names — a lone member always ranks at the 100th
percentile of itself. Coarsening lifts usable ranks from 4 names to 24. **Rejected:** forcing all
36 into rankable buckets, which would have produced a confident number comparing a bank's FCF
yield to a health insurer's. A null is honest; a fake rank is not.
**Enforced:** CI fails if a `rankable: true` theme has fewer than three members.

## 0012 — 2026-09-12 — Ship the first-guess norms, tune from real data
**Decided:** launch with the 17 thresholds in `config/norms.yml` as written. **Why:** they are
first guesses and we know it, but staring at a blank sheet tunes nothing — a week of real data
tells us more than another hour of argument. **Known weakest, in order:** `rsi_weekly` low = 45
(loose; will shade much of the sheet, which makes colour meaningless — 40 is probably right);
`close_vs_sma200d` high = 40 and `close_vs_ema21w` high = 20 (invented, no basis); `fcf_yield`
2%/8% (sector-blind — may need to become a percentile against the stock's own history, which
would be a definition change, not a threshold change). **Revisit:** after one week of live data.

## 0013 — 2026-09-12 — Onboarding, code map and comment discipline are documented and enforced
**Decided:** `ONBOARDING.md` (read order + comprehension check), `CODEMAP.md` (where code lives,
data flow, invariants) and `CODE_STYLE.md` (comment the why; mandatory headers on migrations and
functions). CI rejects a migration without a purpose header. **Why:** almost every file here will
be written by one stateless session and next read by a different one — the reader is always a
stranger, which inverts the usual cost/benefit of commenting. **Rejected:** relying on CLAUDE.md
alone; it loads every turn so it has to stay short, and detailed KT does not fit in it.

## 0014 — 2026-09-12 — One canonical hygiene checklist; everything else points to it
**Decided:** `docs/HYGIENE.md` holds the change-type → required-updates matrix, the branch and
commit conventions, the rules for concurrent sessions, and the definition of done. `CLAUDE.md`,
`ONBOARDING.md`, the PR template and CI **reference** it rather than restating it. **Why:** the
"log before finishing" list had already been copied into four files within a day; with five
contributors over months it would have drifted into four different rules. **Rejected:** keeping
the list in `CLAUDE.md` — it must stay short, and a matrix does not fit. **Also decided:** the
CI log gate is now precise — code requires a FEATURES/INCIDENTS entry, a norm change requires a
DECISIONS entry, docs-only PRs are exempt — because a blunt gate gets satisfied with junk
entries, which is worse than no gate.

## 0015 — 2026-09-12 — MIT licence
**Decided:** MIT. **Why:** the repo is public and has a second contributor, who needs
unambiguous rights to use and modify the result; there is no alpha to protect — the rules are
standard technical analysis; and MIT is the licence every developer already understands.
**Rejected:** no licence (all rights reserved by default, which blocks even the collaborator);
Apache-2.0 (a patent grant irrelevant to a dashboard); a non-commercial licence (only matters
if we'd object to someone else running this, which nobody has suggested).



## 0016 — 2026-09-12 — Migrations deploy via the Supabase GitHub integration; timestamp naming
**Decided:** the project is linked to the repo, so migrations under `supabase/migrations/` are
applied by Supabase when merged to `main`. Files are named `<YYYYMMDDHHMMSS>_<name>.sql` because
that is the format the integration recognises. **Why:** it makes "a human merged the PR" the
confirmation for a schema change, which is strictly stronger than an in-session yes — Claude
never applies a migration at all. It also keeps `supabase_migrations.schema_migrations` as the
single record of what is applied. **Rejected:** applying via MCP/CLI after review (the
integration then sees an unapplied file with a different version and errors), and unlinking the
integration (loses the audit trail for no gain). **Consequence:** never apply a migration by a
side route. The `run-migration` skill says so.
**Also decided:** "automatically expose new tables" is revoked in the first migration rather
than toggled in the dashboard — a setting in code is a setting the next session can see.
\n