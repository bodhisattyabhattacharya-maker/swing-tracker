/**
 * retry_test.ts — the retry loop that exists because of INCIDENTS.md, 2026-09-14.
 *
 * A retry is the kind of code that looks obviously correct and is wrong in ways nobody notices
 * until the outage it was written for happens again: an off-by-one that only ever tries once, a
 * loop that swallows the error it was meant to report, a thrown exception that escapes the loop
 * entirely. So each of those is a test rather than an assumption.
 *
 * `sleep` is injected, so these run instantly and assert the SCHEDULE rather than waiting for it.
 * Pure: no network, no clock, no listener.
 */

import assert from "node:assert/strict";
// The node:assert shim rather than std, for the reason in digest_test.ts: deno.land is unreachable
// from the coding sandbox, so a std import passes in CI and fails for whoever is writing the test.
const assertEquals = (a: unknown, b: unknown, msg?: string) => assert.deepEqual(a, b, msg);

import { DEFAULT_ATTEMPTS, type Postgrestish, readWithRetry } from "./retry.ts";

/** A read that fails `failures` times and then succeeds, counting how often it was called. */
function flaky(failures: number, rows: unknown = [{ ok: true }]) {
  let calls = 0;
  const run = (): Promise<Postgrestish> => {
    calls++;
    return Promise.resolve(
      calls <= failures
        ? { data: null, error: { message: `JWT issued at future (call ${calls})` } }
        : { data: rows, error: null },
    );
  };
  return { run, calls: () => calls };
}

/** Records the delays asked for without waiting for any of them. */
function recordingSleep() {
  const waited: number[] = [];
  return { sleep: (ms: number) => (waited.push(ms), Promise.resolve()), waited };
}

Deno.test("a clean read is not retried and reports one attempt", async () => {
  const f = flaky(0, [{ symbol: "MU" }]);
  const s = recordingSleep();
  const r = await readWithRetry<{ symbol: string }[]>(f.run, { sleep: s.sleep });

  assertEquals(r.failed, false);
  assertEquals(r.data, [{ symbol: "MU" }]);
  assertEquals(r.attempts, 1);
  assertEquals(f.calls(), 1, "a healthy read must not cost extra requests");
  assertEquals(s.waited, [], "and must not sleep at all");
});

Deno.test("the exact 2026-09-14 failure recovers on the second attempt", async () => {
  // One 401 in 144 requests, on one of three parallel reads. This is that, reproduced.
  const f = flaky(1, [{ symbol: "META", param: "rsi_daily" }]);
  const s = recordingSleep();
  const r = await readWithRetry(f.run, { sleep: s.sleep });

  assertEquals(r.failed, false, "a single transient blip must not lose the read");
  assertEquals(r.attempts, 2);
  assertEquals(f.calls(), 2);
  assertEquals(s.waited, [200], "one backoff, the first one");
});

Deno.test("a persistent failure gives up, reports the LAST error, and returns null not empty", async () => {
  const f = flaky(99);
  const s = recordingSleep();
  const r = await readWithRetry(f.run, { sleep: s.sleep });

  assertEquals(r.failed, true);
  assertEquals(r.attempts, DEFAULT_ATTEMPTS);
  assertEquals(f.calls(), DEFAULT_ATTEMPTS, "and stops - a retry loop must have a ceiling");
  assertEquals(s.waited, [200, 600], "no sleep after the final attempt");
  // null, never []. The renderer treats empty as "nothing crossed today" and null as "unknown";
  // returning [] here would turn a failed read into a cheerful quiet day.
  assertEquals(r.data, null);
  assert.match(r.error ?? "", /call 3/, "the reported error is the last one, not the first");
});

Deno.test("a THROWN error is retried like a returned one, and never escapes", async () => {
  // supabase-js returns errors, but a socket dying mid-request throws. Both are the same class of
  // problem to the caller, and an escaping throw would take the whole digest down again.
  let calls = 0;
  const run = (): Promise<Postgrestish> => {
    calls++;
    if (calls < 3) throw new Error(`connection reset (call ${calls})`);
    return Promise.resolve({ data: [{ ok: true }], error: null });
  };
  const r = await readWithRetry(run, { sleep: () => Promise.resolve() });

  assertEquals(r.failed, false);
  assertEquals(r.attempts, 3);
  assertEquals(calls, 3);
});

Deno.test("a throw on every attempt is reported as a failure, not propagated", async () => {
  const run = (): Promise<Postgrestish> => {
    throw new Error("connection reset");
  };
  const r = await readWithRetry(run, { sleep: () => Promise.resolve() });

  assertEquals(r.failed, true);
  assertEquals(r.data, null);
  assert.match(r.error ?? "", /connection reset/);
});

Deno.test("attempts and delays are configurable, and a short delay list is reused", async () => {
  const f = flaky(4);
  const s = recordingSleep();
  const r = await readWithRetry(f.run, { attempts: 5, delaysMs: [10, 20], sleep: s.sleep });

  assertEquals(r.failed, false, "the fifth attempt succeeds");
  assertEquals(f.calls(), 5);
  // Four gaps for five attempts; the list runs out after two and the last value repeats rather
  // than becoming undefined and silently sleeping zero.
  assertEquals(s.waited, [10, 20, 20, 20]);
});

Deno.test("attempts: 1 means no retry at all", async () => {
  const f = flaky(1);
  const s = recordingSleep();
  const r = await readWithRetry(f.run, { attempts: 1, sleep: s.sleep });

  assertEquals(r.failed, true);
  assertEquals(f.calls(), 1);
  assertEquals(s.waited, []);
});
