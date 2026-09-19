# Swing Tracker

An end-of-day dashboard over a fixed watchlist of **53 securities**, flagging the ones sitting
somewhere unusual — cheap enough to buy, or stretched enough to trim.

Two tabs. The **Dashboard** is a 53-row grid of a 51-column catalogue, coloured against norms we
set; **Deep Dive** is one 420px analysis column per security, side by side, for reading one thing
across the whole watchlist. 22 of the 51 columns read live data today; the rest are designed and
say so on the page rather than showing a blank.

Built for swing trades and LEAPS on a 6-month-plus horizon. A tracker, not an advisor —
no score, no ranking.

**Live:** [swing-tracker-nu.vercel.app](https://swing-tracker-nu.vercel.app) ·
current state and what is still blocked: `CLAUDE.md` § Current state.

## Start here

| | |
|---|---|
| **New here?** | `docs/ONBOARDING.md` — 15 minutes, then a comprehension check. |
| **Where does it stand?** | `CLAUDE.md` § Current state — built, not built, and what each blocker is. |
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
web/               Next.js dashboard, desktop-first: two tabs, two allowlist API routes
scripts/           SQL you paste into Supabase, plus ci/ — the gates CI runs
docs/              the context files above
.github/           the CI workflow those gates run in
.claude/           skills + hard-stop settings
```

## This repo is public

No secrets, ever. The Supabase **anon** key is safe to expose — it ships in the browser
bundle by design and is protected by row-level security. The **service_role** key is not,
and must never appear in this repository.

---

MIT licence. Research tooling, not investment advice.
