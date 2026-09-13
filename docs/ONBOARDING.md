# Onboarding — read this once, in this order

For a new agent or a new person. Target: **useful in 15 minutes, dangerous in none.**

`CLAUDE.md` loads automatically every session and carries the rules. This file is the deeper
handover: what to read, in what order, and what each thing actually gives you.

## The read order

| # | Read | Time | What you get | Skip if |
|---|---|---|---|---|
| 1 | `CLAUDE.md` | 3 min | The eight hard constraints, the house rules, the hard stops. **Non-optional.** Most wasted hours on this project came from not knowing one of these. | Never skip |
| 2 | `make context` | 10 sec | Live state: branch, last commit, ticker count, migrations applied. Docs describe intent; this describes reality. | Never skip |
| 3 | `docs/DECISIONS.md` | 5 min | Every settled call and what we rejected. Read before proposing anything architectural — most "good ideas" here were already considered and declined for a reason. | Never skip |
| 4 | `docs/CODEMAP.md` | 2 min | Where code lives, how data flows, entry points. | No code involved in your task |
| 5 | `docs/DEFINITIONS.md` | 5 min | The exact formula for every parameter, anchored to TradingView. | Not touching a number |
| 6 | `docs/CONSTRAINTS.md` | 3 min | Dated facts about external APIs, and dead ends already tried. | Not touching ingest or data |
| 7 | `docs/GLOSSARY.md` | 2 min | "Episode" vs "signal", "norm" vs "rule", "baseline", "edge". These words have specific meanings here. | Never — it is 2 minutes |
| 8 | `docs/FEATURES.md` | skim | What exists and how it works, newest last. | — |
| 9 | `docs/CODE_STYLE.md` | 4 min | How to write code here so the next agent understands it. | Not writing code |
| 10 | `docs/PROPOSAL.md` | 20 min | The full v1 spec — what the product *is*, not what exists. **Versioned, not frozen:** it is revised when scope genuinely changes, and it carries a revision history at the end. Currently **v2**. Read that table first if you last saw an earlier version. | You only need the part your task touches |

Steps 1–3 and 7 are the floor. Everything else is task-dependent.

## Check you actually have the context

If you cannot answer these from the docs, go back — you are about to waste time or break
something:

1. Why can't you write a script that fetches prices? *(CLAUDE.md constraint 1)*
2. Which key is safe to commit, and which is never? *(CLAUDE.md, "This repo is PUBLIC")*
3. Which week do weekly parameters read, and why not the current one? *(constraint 5)*
4. Why is "% off all-time high" measured on highs and not closes? *(constraint 6)*
5. What is the "baseline" a backtest is scored against? *(GLOSSARY)*
6. What happens if you add a rule referencing a searched column? *(skills/add-rule)*
7. How does a viewer refresh the data? *(Trick question — they cannot, and there is no login either. PROPOSAL §4. If you were about to build a button or a role check, stop.)*
8. A scheduled job reports success. Does that mean today's data arrived? *(No. The fetch is dispatched asynchronously, so success means "we asked". The run log and the freshness check are what answer it — PROPOSAL §4, CONSTRAINTS.)*

## Then: your task

Procedures live in `.claude/skills/`. Read the one matching your task before starting.

| Task | Skill |
|---|---|
| Add, drop or retheme a ticker | `add-ticker` |
| Create or tune a rule or colour norm | `add-rule` |
| Change the schema | `run-migration` |
| Data looks stale, missing or wrong | `debug-ingest` |

## The five mistakes new sessions make here

1. **Writing a local fetch script.** It will hang. There is no market-data egress from this
   sandbox — fetching runs inside Supabase. This has cost more time than any other error.
2. **Trusting a computed number without checking `DEFINITIONS.md`.** RSI, EMA and realized
   volatility all have several accepted definitions. Ours are pinned. "It looks about right"
   is not verification.
3. **Editing `PROPOSAL.md` to describe what was built.** It says what the product *is*, not what
   exists — what exists goes in `FEATURES.md` (decision 0010). This is still the common mistake,
   but note the distinction decision 0024 draws: the proposal is **versioned, not frozen**. A
   genuine change of scope earns a revision with an entry in its revision history. A feature
   shipping does not. "We now fetch from a different vendor" is a revision; "the ingest function
   now exists" is a FEATURES entry.
4. **Adding a rule without a backtest, or reading its raw signal count.** Signals are
   autocorrelated — judge sample size by *episodes*. And measure against the baseline, not zero.
5. **Showing a recursive indicator below its warm-up floor.** The number is still reflecting its
   seed. Suppress it instead. Floors are in `DEFINITIONS.md` §4 — **not** `CONSTRAINTS.md`, which
   is about the outside world. `daily_features` publishes a `*_seed_ok` flag per recursive
   indicator so the display layer reads a boolean rather than re-deriving the floor.

## Before you finish

**`docs/HYGIENE.md` is the checklist** — what you changed decides what else you must update.
CI fails a pull request that ships code without a `FEATURES` or `INCIDENTS` entry, changes a
norm without a `DECISIONS` entry, or reuses a decision number. Log it, or it did not happen.
