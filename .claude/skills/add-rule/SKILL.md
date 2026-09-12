---
name: add-rule
description: Add or change a rule or colour norm. Use when asked to create an alert condition, change a threshold, or tune when a cell gets coloured.
---

# Add or change a rule

**Norms** (v1) live in `config/norms.yml`. **Rules** (Phase 2) live as JSON rows.

1. Every rule is **named**. An unnamed rule is unmaintainable in six weeks.
2. Reference parameters by their exact name. A typo fails silently as "never matches" — the CI
   schema check exists to catch this, so run it.
3. **A rule that fires every day is broken, not a signal.** Tighten it.
4. If the rule touches a searched column (analyst target, forward P/E, PEG):
   - it may only be an **AND filter**, never the sole trigger;
   - mark it as partially unbacktestable. We have no history for those columns.
5. Run the backtest and paste before/after edge into the PR. Compare against the **baseline**,
   not against zero — see `docs/GLOSSARY.md`.
6. Report **episodes**, not raw signal count. Autocorrelated signals inflate the sample.
