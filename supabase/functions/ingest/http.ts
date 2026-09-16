/**
 * http.ts — one retry policy for vendor fetches, shared by every provider.
 *
 * WHAT WAS MISSING, AND WHY IT MATTERED
 *
 * `index.ts` has retried SUPABASE reads since the first backfill (`retryRead`). Nothing retried the
 * VENDOR, so a single transient 502 from Polygon lost that symbol for the night: the per-symbol
 * catch records the message, the loop moves on, and the bar arrives 24 hours later on the next
 * scheduled run. Recorded as a verified gap in CONSTRAINTS.md on 2026-09-15 — *"the ingest does not
 * retry vendor fetches, only Supabase reads"* — and this closes it.
 *
 * WHAT IS RETRIED, AND WHAT IS EMPHATICALLY NOT
 *
 *   retried   transport failures: connection reset, DNS blip, TLS hiccup, and a per-attempt
 *             timeout. `fetch` throws for all of these and none of them says anything about
 *             whether the request was reasonable.
 *   retried   HTTP 5xx. The vendor is telling us it is having a problem, not that we asked a bad
 *             question.
 *   NEVER     HTTP 4xx, every one of them. A 401 is a wrong key, a 403 is a plan that does not
 *             cover this, a 404 is a ticker that does not exist. Retrying turns a clear error into
 *             the same clear error, later; the request will never start being valid.
 *   NEVER     HTTP 429, and this one is worth stating separately because it is the tempting
 *             exception. 429 means *stop*. Retrying a rate limit is the exact behaviour that got
 *             Supabase's egress IP blocked by Yahoo for four and a half hours and cost us a whole
 *             provider (INCIDENTS.md 2026-09-13, decision 0019). The caller turns it into a
 *             RateLimitError and abandons the run on purpose. Nothing here may soften that.
 *   NEVER     2xx. Obvious, and said out loud because the retry lives around the fetch rather than
 *             around the parse: a 200 carrying an error BODY (Polygon's `status: NOT_AUTHORIZED`,
 *             FRED's `error_message`) is a vendor answer, not a transport failure, and the mapping
 *             functions already reject it. Retrying it would mean asking a wrong question twice.
 *
 * THE DEADLINE IS THE PART THAT IS EASY TO GET WRONG
 *
 * The edge function has a 150 s wall clock and a run that hits it loses every per-symbol error it
 * had collected — that is how the first live attempt became an unexplainable 504. A per-attempt
 * timeout of 20 s with three attempts is 60 s spent on ONE sick symbol, which is a third of the
 * budget for a thirty-sixth of the work. So retries also run against a wall clock:
 *
 *     an attempt is only started if there is time for it to time out and still be inside deadlineMs
 *
 * With the defaults that means a symbol whose every attempt hangs gets 2 attempts (20 + 0.25 + 20 =
 * 40.25 s, and a third would need 61.25 s), while a symbol getting fast 502s gets all 3 (a few
 * hundred milliseconds). That asymmetry is the intent, not an accident: cheap failures are worth
 * retrying harder than expensive ones.
 *
 * `sleep` and `now` are injectable so the tests assert the policy rather than waiting for it.
 */

/** A retry decision, exported so the tests name the reason rather than infer it from a count. */
export type RetryReason = "transport" | "server";

export interface RetryInfo {
  /** 1-based index of the attempt that just failed. */
  attempt: number;
  attempts: number;
  reason: RetryReason;
  /** HTTP status when there was one, null for a transport failure. */
  status: number | null;
  detail: string;
  delayMs: number;
}

export interface FetchRetryOpts {
  /** Total attempts including the first. */
  attempts?: number;
  /** Pause before attempt n+1. Shorter than the array means the last value repeats. */
  delaysMs?: number[];
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Wall clock for the whole call, retries and pauses included. */
  deadlineMs?: number;
  /** For the log line. */
  label?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onRetry?: (info: RetryInfo) => void;
}

export const DEFAULT_ATTEMPTS = 3;
export const DEFAULT_DELAYS_MS = [250, 1000];

/**
 * Per-attempt timeout. Both providers used 20 s before this file existed and the reasoning has not
 * changed: generous for a 5-year daily payload, and a request that needs longer than that is broken
 * rather than slow. It lives here now so the deadline arithmetic below can see it.
 */
export const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Wall clock for one symbol's fetch, retries included. 45 s is deliberately NOT 3 x 20 s: see the
 * deadline note in the header. It is a third of the function's budget, which is the most one symbol
 * out of thirty-six may take before the run as a whole is the thing at risk.
 */
export const DEFAULT_DEADLINE_MS = 45_000;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function delayFor(delaysMs: number[], attempt: number): number {
  if (delaysMs.length === 0) return 0;
  return delaysMs[Math.min(attempt - 1, delaysMs.length - 1)];
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.message || e.name || "empty error";
  return String(e);
}

/**
 * Fetch with the policy above. Returns the Response for any status that is not 5xx — including
 * every 4xx, which the caller is expected to interpret. Throws the last transport error, or a
 * Response-shaped error for a 5xx, once the attempts or the deadline run out.
 *
 * The caller keeps its existing status handling unchanged. This only decides whether to ask again.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  opts: FetchRetryOpts = {},
): Promise<Response> {
  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS;
  const delaysMs = opts.delaysMs ?? DEFAULT_DELAYS_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const label = opts.label ?? url;
  const onRetry = opts.onRetry ??
    ((i: RetryInfo) =>
      console.warn(
        `${label}: attempt ${i.attempt}/${i.attempts} failed (${i.detail}), retrying in ${i.delayMs} ms`,
      ));

  const startedAt = now();
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let reason: RetryReason;
    let status: number | null = null;
    let detail: string;

    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      // Anything that is not a server fault is the caller's to interpret - including every 4xx.
      // Handing back the Response rather than throwing is what keeps the existing 429 / 401 / 403
      // handling in polygon.ts and fred.ts working exactly as it did.
      if (r.status < 500) return r;
      reason = "server";
      status = r.status;
      detail = `HTTP ${r.status}`;
      // The body is not read. A 5xx body is a vendor error page, and leaving the response
      // undrained here is fine - it is discarded with the response object.
      lastError = new Error(`${label}: HTTP ${r.status}`);
    } catch (e) {
      reason = "transport";
      detail = describe(e);
      lastError = e;
    }

    if (attempt === attempts) break;

    const delayMs = delayFor(delaysMs, attempt);
    // Only start an attempt that can finish inside the deadline. Checked BEFORE the pause so we do
    // not sleep on the way to giving up.
    const elapsed = now() - startedAt;
    if (elapsed + delayMs + timeoutMs > deadlineMs) {
      onRetry({
        attempt,
        attempts,
        reason,
        status,
        detail: `${detail}; no time left for another attempt (${elapsed} ms of ${deadlineMs} ms used)`,
        delayMs: 0,
      });
      break;
    }

    onRetry({ attempt, attempts, reason, status, delayMs, detail });
    await sleep(delayMs);
  }

  throw lastError instanceof Error ? lastError : new Error(describe(lastError));
}
