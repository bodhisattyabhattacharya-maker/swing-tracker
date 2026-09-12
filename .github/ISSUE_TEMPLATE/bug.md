---
name: Bug
about: Something is broken or a number looks wrong
labels: bug
---

## Symptom

<!-- What you actually saw. Ticker, date, parameter, expected vs actual. -->

## Is it data or maths?

- [ ] Data looks stale or missing → check `ingest_runs`, use the `debug-ingest` skill
- [ ] Data is present but the number looks wrong → check `docs/DEFINITIONS.md` formula + warm-up floor
- [ ] Not sure

## Reference value

<!-- If a number is wrong, what does TradingView show? Include the exact figure. -->
