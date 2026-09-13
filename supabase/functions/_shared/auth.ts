/**
 * Lives in `_shared/` because BOTH the ingest and the digest functions need it, and an auth
 * check is the last thing that should exist in two copies that can drift apart. Directories
 * prefixed with an underscore are not deployed as functions by Supabase - that is the
 * documented way to share code between them.
 *
 * auth.ts — who may trigger an ingest.
 *
 * The rule (decision 0017): only the project's service role. Two ways to prove it, either is
 * enough:
 *
 *   1. The bearer's JWT payload carries `role: "service_role"`. The gateway has ALREADY verified
 *      the signature before the function runs (`verify_jwt = true` in supabase/config.toml), so
 *      decoding the payload without re-verifying is safe HERE and only here. If verify_jwt is
 *      ever switched off, this check becomes forgeable - which is why config.toml says not to.
 *   2. The bearer is byte-identical to the runtime's SUPABASE_SERVICE_ROLE_KEY env var.
 *
 * Why both: the first deploy accepted only (2) and rejected a genuine service_role JWT with a
 * 401 (INCIDENTS.md 2026-09-13). The value the runtime injects is not necessarily the legacy
 * key shown on the dashboard's API Keys page, and nothing in this repo can inspect it. (1)
 * depends only on what the token says about itself, after the gateway vouched for it.
 *
 * Pure functions, no Deno.env inside, so they are unit-tested in ingest_test.ts.
 */

import { timingSafeEqual } from "node:crypto";

export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  return token || null;
}

/** Role claim from a JWT payload, without verifying the signature. Null if it is not a JWT. */
export function jwtRole(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded));
    return typeof payload?.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

/** Constant-time compare so a byte match cannot be probed by timing. */
function sameBytes(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  // node:crypto's timingSafeEqual throws on unequal lengths; a length mismatch is simply "no".
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * @param token     the bearer presented by the caller (null if absent)
 * @param expected  the runtime's SUPABASE_SERVICE_ROLE_KEY (undefined if the env is missing)
 */
export function callerAllowed(token: string | null, expected: string | undefined): boolean {
  if (!token) return false;
  if (expected && sameBytes(token, expected)) return true;
  return jwtRole(token) === "service_role";
}
