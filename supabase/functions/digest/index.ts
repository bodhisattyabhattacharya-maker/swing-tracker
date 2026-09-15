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
 *   - It does not retry THE SEND. One send per scheduled run; a failure is recorded and the next
 *     run is tomorrow. Retrying an email risks sending two, which is worse than sending none.
 *     Its READS are retried, which is a different decision entirely - see retry.ts for why.
 *   - It does not go silent because a read failed. Added 2026-09-14, after the first scheduled run
 *     sent nothing: one of three reads came back 401 from a PostgREST replica with a drifted clock,
 *     and the throw discarded the two that had succeeded. Now the reads are retried, and whatever
 *     survives is sent with the gap named at the top. A partial email beats an absent one, because
 *     an email that does not arrive looks exactly like a quiet market. INCIDENTS.md, 2026-09-14.
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
import { readWithRetry } from "./retry.ts";

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
    // Still parallel, so the retries cost one wall-clock delay rather than three. A read that
    // exhausts its attempts returns null and names itself in `unavailable`; it no longer takes the
    // other two down with it.
    const [st, ch, sd] = await Promise.all([
      readWithRetry<Status>(() => sb.from("grid_status").select("*").single()),
      readWithRetry<Change[]>(() => sb.from("digest_changes").select("*").order("symbol")),
      readWithRetry<Standing[]>(() => sb.from("digest_standing").select("*")),
    ]);

    const reads = { grid_status: st, digest_changes: ch, digest_standing: sd };
    const unavailable = Object.entries(reads).filter(([, r]) => r.failed).map(([n]) => n);
    const readErrors = Object.fromEntries(
      Object.entries(reads).filter(([, r]) => r.failed).map(([n, r]) => [n, r.error]),
    );
    // Logged even when every read succeeded first time: a run that needed two attempts is the early
    // warning for the replica problem that caused this code to exist.
    const readAttempts = Object.fromEntries(
      Object.entries(reads).map(([n, r]) => [n, r.attempts]),
    );

    const gridUrl = Deno.env.get("GRID_URL") ?? "https://swing-tracker-nu.vercel.app/";
    const { subject, text } = renderDigest(st.data, ch.data, sd.data, gridUrl, unavailable);

    if (dryRun) {
      return json({
        ok: true,
        dry_run: true,
        subject,
        text,
        changes: ch.data?.length ?? null,
        unavailable,
        read_attempts: readAttempts,
      });
    }

    const to = (Deno.env.get("DIGEST_TO") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (to.length === 0) throw new Error("DIGEST_TO is not set - nobody to send to");
    const from = Deno.env.get("DIGEST_FROM") ?? "Swing Tracker <onboarding@resend.dev>";

    const sent = await send(to, from, subject, text);

    // Recorded in the same log as every other scheduled run. scope='digest' writes no `daily`
    // key, so it cannot be mistaken for evidence that prices arrived - see grid_status.
    //
    // `ok` answers exactly one question: did mail go out? A degraded email that reached the
    // recipients is ok:true, with `unavailable` naming what was missing from it. Conflating "sent
    // something partial" with "sent nothing" would blunt the one row that told the truth on
    // 2026-09-14 when cron.job_run_details said `succeeded`.
    await sb.from("ingest_runs").insert({
      source: "resend",
      scope: "digest",
      triggered_by: url.searchParams.get("by") ?? "schedule",
      finished_at: new Date().toISOString(),
      ok: true,
      detail: {
        digest: {
          subject,
          recipients: to.length,
          message_id: sent.id,
          ...(unavailable.length ? { unavailable, read_errors: readErrors } : {}),
          read_attempts: readAttempts,
        },
      },
    });

    return json({ ok: true, subject, recipients: to.length, message_id: sent.id, unavailable });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Reaching here now means the SEND failed, or something outside the read path did - a failed
    // read degrades the email instead of landing here. Recorded either way, because a digest that
    // silently stopped arriving is indistinguishable from a quiet market, which is the one thing
    // this email exists to rule out.
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
