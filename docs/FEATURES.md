# Features

One entry per shipped feature: what we built, how it works, and what it changed
architecturally. Written **after** building. Newest last.

Read alongside `DECISIONS.md` and you have the full history — every significant choice, and
everything built as a result.

**Template**

```
## YYYY-MM-DD — <feature name>
**What:** one or two sentences on what now exists.
**How:** the mechanism. Files, tables, functions touched.
**Architecture impact:** what this changes for anything built on top of it. "None" is a valid
answer, but say it.
**Verified by:** the test or check that proves it works.
**By:** <human> + <agent>
```

---

## 2026-09-05 — Indicator formulas verified against TradingView
**What:** RSI(14), EMA(21) and SMA(50/200) confirmed to match TradingView's Pine definitions.
Five golden values recorded for Micron.
**How:** three independent implementations compared — production SQL over full history, a Python
reference implementing `ta.rma` / `ta.ema` / `ta.sma` directly, and pandas `ewm` as a third code
path. Agreement to 1x10^-6 across *different windows and different seeding*, which is stronger
evidence than two runs of the same code. Wilder-vs-simple RSI and EMA seed sensitivity were both
quantified rather than assumed.
**Architecture impact:** fixes Wilder smoothing as non-negotiable, and establishes warm-up floors
that every future recursive indicator must respect.
**Verified by:** the five figures in `DEFINITIONS.md` section 6. **Not yet committed as test
fixtures** — that lands with the test harness.
**By:** Bodhi + Claude

## 2026-09-12 — Repository scaffold
**What:** the repo skeleton — context files, config, CI, skills, hard-stop settings.
**How:** `CLAUDE.md` as the always-read guardrail index; `docs/` for the narrative files;
`config/watchlist.yml` and `config/norms.yml` so the two things we tune most are data, not code;
`.gitignore` written before the first commit because the repo is public.
**Architecture impact:** establishes that watchlist and norms are edited as config. Anything
reading them must read the files, never hardcode.
**Verified by:** `make context` runs; `git status` clean after the initial commit.
**By:** Bodhi + Claude

## 2026-09-12 — Onboarding path, code map and comment discipline
**What:** `docs/ONBOARDING.md`, `docs/CODEMAP.md`, `docs/CODE_STYLE.md`, plus a coarser theme
structure in `config/watchlist.yml`.
**How:** ONBOARDING gives a sequenced read order with time boxes, a six-question comprehension
check, and the five mistakes new sessions repeat. CODEMAP carries the data-flow diagram, a
"where do I start reading for question X" table, and five invariants meant to outlive refactors.
CODE_STYLE mandates why-not-what comments and purpose headers, with good/bad examples on the
three live traps (the weekly join, Wilder smoothing, `rows` vs `range`). Watchlist gained a
coarse `theme` for ranking and a granular `tag` for display.
**Architecture impact:** two new CI gates — a `rankable: true` theme must have 3+ members, and
every migration must open with a 3-line purpose header. Both fail the build rather than asking.
**Verified by:** config validation run locally (36 tickers, 7 themes, 24 rankable, no undeclared
themes); all `CLAUDE.md` cross-references resolve.
**By:** Bodhi + Claude

## 2026-09-12 — Change hygiene, setup guide, and a tightened foundation
**What:** `docs/HYGIENE.md` (the canonical change matrix, commit format, concurrent-session
rules, definition of done) and `docs/SETUP.md` (one-time account wiring, per-contributor steps).
Every duplicated "what to update" list now points at HYGIENE instead.
**How:** CI `hygiene` job enforces the matrix precisely — code → FEATURES/INCIDENTS, norm →
DECISIONS, theme structure → DECISIONS, unique decision numbers — and warns on a new doc missing
from `CLAUDE.md`'s table. Commit trailers carry the agent and session URL so `git blame` means
something with five sessions. A false claim in `DEFINITIONS.md` (golden values "committed as
fixtures") corrected to "will be, when the harness lands".
**Architecture impact:** HYGIENE is now the single source for process rules. Changing a rule
means changing one file.
**Verified by:** `ci.yml` parses; all `CLAUDE.md` pointers resolve; config gate passes locally.
**By:** Bodhi + Claude

