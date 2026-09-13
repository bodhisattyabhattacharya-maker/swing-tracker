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
- [x] `pg_net` and `pg_cron` — enabled by migration `20260912120000_foundation`.
- [x] **GitHub integration linked** to the repo. Migrations under `supabase/migrations/` deploy
      when merged to `main` (decision 0016). This replaces the manual-apply hard stop with
      "a human merges the PR" — strictly stronger, since Claude never applies anything.
- [x] Project Settings → Integrations → GitHub → **"Deploy to production" ON**, production
      branch `main`, working directory `.`. **Off by default** — linking alone deploys nothing
      (constraint dated 2026-09-12). Enabling it does not replay past merges.
- [ ] Project Settings → Vault → **Add new secret**: name `service_role_key`, value = the
      `service_role` key from Project Settings → API Keys. This is how pg_cron (and a human
      running `net.http_post` in the SQL editor) authenticates to the ingest function
      (decision 0017). The key never leaves Supabase; it is read with
      `select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'`.
- [x] "Enable automatic RLS" was ticked at creation. "Automatically expose new tables" was
      left on and is **revoked in the first migration** instead, so it is explicit and reviewable.

## Owner — data providers, once (decision 0019)

- [ ] **Polygon** (the site is now massive.com; the API host is still `api.polygon.io`). Sign up
      free, copy the API key. Free tier is 5 requests/minute and 2 years of history, and is
      licensed for "individual use".
- [ ] **FRED** — `fredaccount.stlouisfed.org/apikeys`, free, instant. This is the St. Louis Fed.
- [ ] Supabase → **Edge Functions → Secrets** (not Vault — Vault holds the key pg_cron uses to
      *call* the function; these are read *by* the function): add `POLYGON_API_KEY` and
      `FRED_API_KEY`, then press Save. The form keeps unsaved values looking correct, so check
      both appear under "Custom secrets" afterwards.
- [ ] Neither key goes in the repo, in `.env.example`, or into a chat. The repo is public.

## Owner — Vercel, once

- [ ] Import the GitHub repo. **Set Root Directory to `web/`** — the repo root holds `supabase/`
      and `docs/` too, and Vercel will not find the app without this.
- [ ] Framework preset: Next.js. Build command, output directory and install command: leave as
      the detected defaults. Node 22.
- [ ] Environment variables (Production + Preview): `NEXT_PUBLIC_SUPABASE_URL` and
      `NEXT_PUBLIC_SUPABASE_ANON_KEY`. **Only these two.** The `NEXT_PUBLIC_` prefix means Next
      compiles them into the browser bundle; the anon key is designed for that, the service_role
      key must never be given that prefix or put in this project at all.
- [ ] Confirm the pipeline: open the deployed URL and check the commit SHA on the page matches
      the latest merge to `main`, and that both variables read "set".
- [ ] The other contributor needs **no Vercel account** — deployment is a side effect of merging.

## Each contributor

- [ ] GitHub account; accept the collaborator invite.
- [ ] Install git, Node 22+, and Claude Code signed in with your own account. `gh` is optional.
- [ ] `git clone`, then `cp .env.example .env.local` and fill in the anon key only.
- [ ] Accept the Supabase team invite.
- [ ] Read `docs/ONBOARDING.md`. Do the comprehension check.
- [ ] **Do not run git through the Cowork device shell** — it cannot delete files and will wedge
      the repo on its own lock file. Use GitHub Desktop or a native terminal.
