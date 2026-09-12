# Change hygiene — what every change must update

**The single canonical checklist.** `CLAUDE.md`, `ONBOARDING.md`, the PR template and CI all
point here rather than repeating it, so there is exactly one place to change when the rules change.

This project will run for months with five or more stateless contributors. A change that
lands without its paper trail is a change the next session cannot understand, and will
eventually undo.

## Before you start

1. **One issue per change**, including bug fixes. The issue holds the intent; the commit only
   records the result.
2. **Branch from `main`**, named `<issue-number>-<short-slug>` — e.g. `42-weekly-rsi-floor`.
3. **Never commit to `main`.** Never force-push a shared branch. Never rebase one someone else
   may have pulled.
4. Read the skill in `.claude/skills/` that matches the task.

## The matrix — what you changed, what you must also update

| You changed… | You must also update | Enforced |
|---|---|---|
| Any code under `supabase/`, `web/`, `scripts/` | `docs/FEATURES.md` (new capability) **or** `docs/INCIDENTS.md` (a fix) | CI |
| A migration | Its purpose header; `docs/CODEMAP.md` if it adds a table or entry point | CI (header) |
| How a parameter is computed | `docs/DEFINITIONS.md` **in the same commit**; re-run golden values | CI, once the test harness exists |
| `config/norms.yml` | `docs/DECISIONS.md` — a threshold is a judgment, and the next session needs the reasoning | CI |
| `config/watchlist.yml` themes or `rankable` flags | `docs/DECISIONS.md` | CI validates structure |
| Directory layout, or any entry point | `docs/CODEMAP.md` | review |
| A fact about an external API, or a dead end that burned two attempts | `docs/CONSTRAINTS.md`, **dated** | review |
| A call with alternatives you rejected | `docs/DECISIONS.md`, numbered | CI (unique numbers) |
| The meaning of a word, or a new term | `docs/GLOSSARY.md` | review |
| **Product scope** — what the thing *is* | `docs/PROPOSAL.md`, and nothing else touches it | review |
| Any file that appears in the table in `CLAUDE.md` | That table | review |

"Enforced: review" means the other human checks it in the PR. Everything marked CI fails the
build, because a norm that depends on memory fails with stateless contributors.

## Commit format

```
<type>: <what changed, imperative, under 72 chars>

<why — only if the diff does not make it obvious>

Closes #<issue>
Co-Authored-By: Claude <model name> <noreply@anthropic.com>
Claude-Session: <session url>
```

Types: `feat` `fix` `docs` `config` `ci` `chore`.

The human is the git author. The agent is the `Co-Authored-By`. The session URL is how "who
changed what" survives at the mechanical layer — without it, `git blame` says "Claude" and
nothing more, which is useless with five sessions running.

## Working alongside other sessions

- **`DECISIONS.md` numbers:** take the highest existing number plus one **at merge time**. If
  two branches both claim `0014`, the second to merge renumbers. CI rejects duplicates.
- **Append-only files** (`FEATURES`, `INCIDENTS`, `CONSTRAINTS`, `DECISIONS`) **will conflict**
  when two branches append. This is normal. Resolve by keeping **both** entries, ordered by date.
  Never discard the other session's entry to make the conflict go away.
- **Check `make context` before assuming state.** Another session may have merged since you
  branched.

## Definition of done

A pull request is done when **all** of these hold:

- CI is green — secret scan, config validation, log-entry gate, migration headers, unique
  decision numbers.
- Every row of the matrix that applies has been satisfied.
- The blast radius in the PR template is ticked honestly.
- The other human has reviewed it. Two people, two eyes, no exceptions for "trivial".
- **No secret in the diff.** The repo is public. This one is not negotiable and CI checks it, but
  CI is the last line, not the first.

## If you cannot finish

Say so in the PR or the issue: what is done, what is verified, what is left. A half-finished
change with an honest note is recoverable. A half-finished change that looks finished is not.
