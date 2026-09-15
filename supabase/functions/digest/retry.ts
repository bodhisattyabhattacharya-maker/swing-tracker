/**
 * digest/retry.ts — retry a READ, and only a read.
 *
 * WHY THIS EXISTS, precisely. On 2026-09-14 the first scheduled digest sent nothing. Its three
 * PostgREST reads left in the same millisecond carrying the same service_role key; two came back
 * 200 and one came back 401 "JWT issued at future". Across the seven hours around that run there
 * were 144 requests on that key and exactly one 401 — one node in a load-balanced fleet whose clock
 * had drifted behind the key's `iat`. Nothing about it was reproducible or ours to fix.
 *
 * What WAS ours: a single blip on one of three reads threw away the two that had succeeded and
 * produced silence — the exact ambiguity decision 0027 says this email exists to remove.
 * See INCIDENTS.md, 2026-09-14.
 *
 * ---------------------------------------------------------------------------
 * READS ARE RETRIED. THE SEND IS NOT. The distinction is the whole design.
 *
 * index.ts has said since it was written: "It does not retry. Retrying an email risks sending two,
 * which is worse than sending none." That judgment stands and this file does not weaken it. A
 * PostgREST GET is idempotent — running it three times costs milliseconds and can produce nothing
 * worse than the same rows twice. A Resend POST is not idempotent, and a duplicate digest in ten
 * inboxes cannot be recalled. So: retry the reads, never the send.
 * ---------------------------------------------------------------------------
 *
 * Kept out of index.ts for the same reason render.ts is: index.ts calls `Deno.serve` at module top
 * level, so importing it from a test starts a real HTTP listener. Everything here is injectable —
 * a test passes its own `sleep` and never waits.
 */

/**
 * The shape supabase-js returns. Declared structurally so this file imports nothing.
 *
 * Note `PromiseLike`, not `Promise`, everywhere a builder is accepted below. `sb.from(x).select()`
 * returns a PostgrestBuilder, which is a THENABLE - it has `.then` but not `.catch` or `.finally`,
 * so it does not satisfy `Promise`. `await` treats the two identically, so this typed as `Promise`
 * ran correctly and failed `deno check`, which is the CI step that would have caught it at merge.
 */
export interface Postgrestish {
  data: unknown;
  error: { message: string } | null;
}

export interface ReadResult<T> {
  /** Rows on success, null when every attempt failed. Null is "unknown", never "empty". */
  data: T | null;
  failed: boolean;
  /** The last error message, for the run log. Absent on success. */
  error?: string;
  /** How many attempts it took. 1 on a clean read; useful for spotting a replica going bad. */
  attempts: number;
}

/**
 * Three attempts, ~200 ms then ~600 ms apart. Worst case adds under a second, against a function
 * budget of 150 s, and the three reads run in parallel so the cost is paid once rather than thrice.
 */
export const DEFAULT_ATTEMPTS = 3;
export const DEFAULT_DELAYS_MS = [200, 600];

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run a PostgREST read, retrying on ANY error.
 *
 * Deliberately not selective about which errors to retry. Sorting transient from permanent by
 * inspecting a message string is guesswork that rots the first time a vendor rewords an error, and
 * the downside is asymmetric: retrying a permanent failure costs two extra GETs and still reports
 * the failure, while not retrying a transient one costs the email. So it retries everything up to
 * the cap and reports honestly if the cap is reached.
 */
export async function readWithRetry<T>(
  run: () => PromiseLike<Postgrestish>,
  opts: {
    attempts?: number;
    delaysMs?: number[];
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<ReadResult<T>> {
  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS;
  const delays = opts.delaysMs ?? DEFAULT_DELAYS_MS;
  const sleep = opts.sleep ?? realSleep;

  let lastError = "no attempt was made";

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res: Postgrestish;
    try {
      res = await run();
    } catch (e) {
      // A thrown error (a socket dying mid-request) is the same class of problem as a returned
      // one, and must not escape past the retry loop.
      res = { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
    }

    if (!res.error) return { data: res.data as T, failed: false, attempts: attempt };

    lastError = res.error.message;
    if (attempt < attempts) await sleep(delays[attempt - 1] ?? delays[delays.length - 1] ?? 0);
  }

  return { data: null, failed: true, error: lastError, attempts };
}
