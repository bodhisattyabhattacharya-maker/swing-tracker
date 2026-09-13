/**
 * Deployment check page. This is NOT the dashboard.
 *
 * Purpose: prove the Vercel pipeline before anything depends on it — that the repo imports with
 * `web/` as the root directory, that a merge to `main` triggers a deploy, and that environment
 * variables actually reach the running app. Twice already a deploy path looked wired and was not
 * (the Supabase "Deploy to production" toggle was off; the function's service key was not what we
 * assumed), so the pipeline gets verified on its own before a grid is built on top of it.
 *
 * Reads NO data. The tables are RLS deny-by-default with no policies, so a browser can read
 * nothing yet by design — the auth model and read policies are a deliberate decision still to be
 * made, not an oversight to route around.
 *
 * SECRETS: this prints whether a variable is SET, never its value. `NEXT_PUBLIC_*` variables are
 * compiled into the browser bundle by Next, so only the anon key may ever carry that prefix. The
 * service_role key must never appear in this directory in any form (CLAUDE.md, "This repo is
 * PUBLIC").
 *
 * Rendered per request, not at build time, so setting an env var in Vercel shows up on a refresh
 * instead of needing a rebuild — which is the thing we are trying to observe.
 */
export const dynamic = "force-dynamic";

/** Presence only. Returning the value here would leak it into the page. */
function isSet(name: string): boolean {
  const v = process.env[name];
  return typeof v === "string" && v.length > 0;
}

function Flag({ on }: { on: boolean }) {
  return <span className={on ? "yes" : "no"}>{on ? "set" : "not set"}</span>;
}

export default function DeploymentCheck() {
  // Vercel injects these at build; they are absent on a local `next dev`, which is itself
  // a useful signal that you are looking at localhost and not the deployment.
  const sha = process.env.VERCEL_GIT_COMMIT_SHA ?? null;
  const branch = process.env.VERCEL_GIT_COMMIT_REF ?? null;
  const env = process.env.VERCEL_ENV ?? "local";

  return (
    <main>
      <h1>Swing Tracker</h1>
      <p className="sub">
        Deployment check — the dashboard does not exist yet. See <code>docs/FEATURES.md</code> for
        what is actually built.
      </p>

      <div className="panel">
        <h2>Build</h2>
        <table>
          <tbody>
            <tr>
              <td>Environment</td>
              <td><code>{env}</code></td>
            </tr>
            <tr>
              <td>Branch</td>
              <td><code>{branch ?? "—"}</code></td>
            </tr>
            <tr>
              <td>Commit</td>
              <td><code>{sha ? sha.slice(0, 7) : "—"}</code></td>
            </tr>
            <tr>
              <td>Rendered at</td>
              <td><code>{new Date().toISOString()}</code></td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h2>Environment variables</h2>
        <table>
          <tbody>
            <tr>
              <td>
                <code>NEXT_PUBLIC_SUPABASE_URL</code>
              </td>
              <td><Flag on={isSet("NEXT_PUBLIC_SUPABASE_URL")} /></td>
            </tr>
            <tr>
              <td>
                <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>
              </td>
              <td><Flag on={isSet("NEXT_PUBLIC_SUPABASE_ANON_KEY")} /></td>
            </tr>
          </tbody>
        </table>
        <p className="sub" style={{ margin: "14px 0 0", fontSize: 13 }}>
          Presence only, never values. The anon key is safe in a browser bundle behind RLS; the
          service_role key belongs nowhere near this directory.
        </p>
      </div>

      <footer>
        If the commit above matches the latest merge to <code>main</code>, deploy-on-merge works.
      </footer>
    </main>
  );
}
