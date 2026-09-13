/**
 * digest/index.ts — the weekday email. The phone surface (PROPOSAL §4 "Surfaces").
 *
 * Job: three lines on what crossed a norm today, with a link to the grid. When nothing crossed, it
 * SAYS SO rather than not arriving - an email that only shows up on interesting days is one you
 * cannot distinguish from a broken pipeline.
 *
 * WHAT IT WILL NOT DO, and why each is deliberate:
 *   - It does not decide what is interesting. It reports which cells crossed a norm WE set. The
 *     difference between "MU's weekly RSI is below 35" and "MU is a buy" is the whole product.
 *   - It does not send a normal-looking digest when the pipeline is behind. A cheerful "nothing
 *     crossed a norm today" computed from three-day-old data is a lie, and it is the most
 *     believable kind. Stale means the email leads with that and nothing else.
 *   - It does not retry. One send per scheduled run; a failure is recorded and the next run is
 *     tomorrow. Retrying an email risks sending two, which is worse than sending none.
 *
 * DRY RUN: `?send=0` renders and returns the email WITHOUT sending it. Use it every time before
 * changing anything about the content. Sending is irreversible - you cannot unsend to ten people -
 * so the default path when testing is the one that cannot embarrass you.
 *
 * SECRETS, all edge-function secrets and none of them in this repo:
 *   RESEND_API_KEY - from resend.com
 *   DIGEST_TO      - comma-separated recipients. **Deliberately not in config/norms.yml**: this
 *                    repo is public and those are personal email addresses. The watchlist and the
 *                    norms are ours to publish; other people's inboxes are not.
 *   DIGEST_FROM    - the From: address, e.g. "Swing Tracker <onboarding@resend.dev>"
 *   GRID_URL       - link target, so the email points at the dashboard.
 */

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { bearerToken, callerAllowed } from "../_shared/auth.ts";
import { type Change, renderDigest, type Standing, type Status } from "./render.ts";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const REQUEST_TIMEOUT_MS = 20_000;

async function send(
  to: string[],
  from: string,
  subject: string,
  text: string,
): Promise<{ id: string }> {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) throw new Error("RESEND_API_KEY is not set on the function");

  const r = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, text }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!r.ok) {
    throw new Error(`resend: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
  }
  return await r.json() as { id: string };
}

function authorized(req: Request): boolean {
  return callerAllowed(bearerToken(req), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);

  const url = new URL(req.url);
  // Sending is the default ONLY because the scheduler calls it with no parameters. Any hand call
  // that is not explicitly `?send=1` should be a dry run - see the header.
  const dryRun = url.searchParams.get("send") === "0";

  const sb: SupabaseClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const [{ data: st, error: stErr }, { data: ch, error: chErr }, { data: sd, error: sdErr }] =
      await Promise.all([
        sb.from("grid_status").select("*").single(),
        sb.from("digest_changes").select("*").order("symbol"),
        sb.from("digest_standing").select("*"),
      ]);
    if (stErr) throw new Error(`grid_status: ${stErr.message}`);
    if (chErr) throw new Error(`digest_changes: ${chErr.message}`);
    if (sdErr) throw new Error(`digest_standing: ${sdErr.message}`);

    const gridUrl = Deno.env.get("GRID_URL") ?? "https://swing-tracker-nu.vercel.app/";
    const { subject, text } = renderDigest(
      st as Status,
      (ch ?? []) as Change[],
      (sd ?? []) as Standing[],
      gridUrl,
    );

    if (dryRun) {
      return json({ ok: true, dry_run: true, subject, text, changes: (ch ?? []).length });
    }

    const to = (Deno.env.get("DIGEST_TO") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (to.length === 0) throw new Error("DIGEST_TO is not set - nobody to send to");
    const from = Deno.env.get("DIGEST_FROM") ?? "Swing Tracker <onboarding@resend.dev>";

    const sent = await send(to, from, subject, text);

    // Recorded in the same log as every other scheduled run. scope='digest' writes no `daily`
    // key, so it cannot be mistaken for evidence that prices arrived - see grid_status.
    await sb.from("ingest_runs").insert({
      source: "resend",
      scope: "digest",
      triggered_by: url.searchParams.get("by") ?? "schedule",
      finished_at: new Date().toISOString(),
      ok: true,
      detail: { digest: { subject, recipients: to.length, message_id: sent.id } },
    });

    return json({ ok: true, subject, recipients: to.length, message_id: sent.id });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Recorded even on failure, because a digest that silently stopped arriving is indistinguishable
    // from a quiet market - which is the one thing this email exists to rule out.
    await sb.from("ingest_runs").insert({
      source: "resend",
      scope: "digest",
      triggered_by: url.searchParams.get("by") ?? "schedule",
      finished_at: new Date().toISOString(),
      ok: false,
      detail: { digest: { error: message } },
    });
    return json({ ok: false, error: message }, 500);
  }
});
