# Setup — one-time, and per contributor

`ONBOARDING.md` is how a session learns the project. This is how the *accounts and services* get
wired. Owner steps happen once; contributor steps happen per person.

## Owner — GitHub, once

- [ ] Create the repository, **public** (decision 0008).
- [ ] Settings → Code security → enable **secret scanning** and **push protection**. Free on
      public repos; this is the first line of defence, CI is the last.
- [ ] Settings → Branches → rule for `main`: require a pull request, require status checks to
      pass (all CI jobs), block force pushes. Free on public repos.
- [ ] Settings → Secrets and variables → Actions: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
      **These are the only place the service-role key ever lives.**
- [ ] Settings → Collaborators → add the other human with **Write**.
- [ ] Issues on; create a Project board.
- [x] `LICENSE` is MIT (decision 0015). Public code with no licence is "all rights reserved"
      by default — even a collaborator cannot legally use it.

## Owner — Supabase, once

- [ ] Create the project in **your own Supabase organisation**, not the Vercel-managed one
      (decision 0009; constraint dated 2026-09-12).
- [ ] Organisation → Team → invite the other human as **Developer**.
- [ ] Copy the **anon** key into `.env.local` (never committed). Copy the **service_role** key
      into GitHub Actions secrets and nowhere else.
- [ ] Enable `pg_net` and `pg_cron`.

## Owner — Vercel, once

- [ ] Import the GitHub repo. Auto-deploy on push to `main`.
- [ ] The other contributor needs **no Vercel account** — deployment is a side effect of merging.

## Each contributor

- [ ] GitHub account; accept the collaborator invite.
- [ ] Install git, Node 22+, and Claude Code signed in with your own account. `gh` is optional.
- [ ] `git clone`, then `cp .env.example .env.local` and fill in the anon key only.
- [ ] Accept the Supabase team invite.
- [ ] Read `docs/ONBOARDING.md`. Do the comprehension check.
- [ ] **Do not run git through the Cowork device shell** — it cannot delete files and will wedge
      the repo on its own lock file. Use GitHub Desktop or a native terminal.
