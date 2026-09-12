## What and why

<!-- One or two sentences. -->

Closes #

## Blast radius

<!-- Tick every layer this touches, so a reviewer knows where to look. -->

- [ ] Schema / migrations
- [ ] Ingest (edge functions, scheduling)
- [ ] Parameters / formulas
- [ ] Norms or rules
- [ ] Frontend
- [ ] Docs / config only

## Hygiene — see `docs/HYGIENE.md` for the full matrix

<!-- Tick what applies. CI enforces the ones it can; the reviewer checks the rest. -->

- [ ] Code changed → `docs/FEATURES.md` or `docs/INCIDENTS.md` entry
- [ ] Formula changed → `docs/DEFINITIONS.md` updated **in this PR**, golden values re-run
- [ ] Norm or theme changed → `docs/DECISIONS.md` entry with the reasoning
- [ ] Structure or entry point changed → `docs/CODEMAP.md`
- [ ] Learned something about an external API → `docs/CONSTRAINTS.md`, dated
- [ ] New term or changed meaning → `docs/GLOSSARY.md`
- [ ] New doc → added to the table in `CLAUDE.md`

## Evidence

<!-- Required if this changes a rule, a norm, or a formula. -->

- **Backtest before → after (edge vs baseline, episodes):**
- **Golden values still pass:** yes / no / n/a

## Secrets

- [ ] No keys, `.env` files or connection strings in this diff. **This repo is public.**
