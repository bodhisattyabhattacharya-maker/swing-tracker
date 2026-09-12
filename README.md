# Swing Tracker.

An end-of-day dashboard that tracks 26 parameters across a fixed watchlist of ~40 names,
and flags the ones sitting somewhere unusual — cheap enough to buy, or stretched enough to trim.

Built for swing trades and LEAPS on a 6-month-plus horizon. A tracker, not an advisor.

## Start here

| | |
|---|---|
| **New here?** | `docs/ONBOARDING.md` — 15 minutes, then a comprehension check. |
| **About to change something?** | `docs/HYGIENE.md` — what else you must update. |
| **Wiring accounts?** | `docs/SETUP.md` |
| The plan | `docs/PROPOSAL.md` |
| Exact formulas | `docs/DEFINITIONS.md` |
| Why things are the way they are | `docs/DECISIONS.md` |
| Facts about the outside world | `docs/CONSTRAINTS.md` |
| What's been built | `docs/FEATURES.md` |
| What's broken before | `docs/INCIDENTS.md` |

## Layout

```
config/            watchlist.yml, norms.yml  — edit these, not code
supabase/          migrations + edge functions (the data plane)
web/               Next.js dashboard (desktop-first)
scripts/           local helpers
docs/              the context files above
.claude/           skills + hard-stop settings
```

## This repo is public

No secrets, ever. The Supabase **anon** key is safe to expose — it ships in the browser
bundle by design and is protected by row-level security. The **service_role** key is not,
and must never appear in this repository.

---

MIT licence. Research tooling, not investment advice.
