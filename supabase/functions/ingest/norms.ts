/**
 * norms.ts — read config/norms.yml from the public repo and shape it for `norms` and `flags`.
 *
 * Same contract as watchlist.ts and for the same reason: the yml is the source of truth and the
 * tables are a cache (the tables' own comments say so). Fetching the file each run is what makes
 * "tighten a threshold, commit, next run applies it" true without a deploy.
 *
 * WHY TWO TABLES FROM ONE FILE: the yml deliberately separates `norms:` from `flags:`, and the
 * distinction is not cosmetic. A norm means "we have an opinion about this number" and renders as
 * colour. A flag means "this number may not be trustworthy" and renders as an icon with a label,
 * never colour alone. Merging them would lose that, and the dashboard would end up implying a
 * judgment where it only has a caveat.
 *
 * THE GUARD: parsing an empty `norms:` block THROWS. The sync deletes norms that have been removed
 * from the yml - it has to, or a norm deleted in git would keep silently colouring cells forever
 * (`rs_vs_sox_6m` was removed exactly that way in decision 0019). That delete is what makes a
 * truncated or half-written file dangerous: it would wipe every verdict on the dashboard. So an
 * empty parse is treated as a broken file rather than as "the user removed all norms", which is
 * the same protection watchlist.ts has against a truncated watchlist deactivating every ticker.
 */

import { parse } from "npm:yaml@2";

/** One row of `norms`. Both bounds nullable, and which ones are set is meaningful. */
export interface NormRow {
  param: string;
  low: number | null;
  high: number | null;
  source: string;
}

/** One row of `flags`. `value` is stored as jsonb because the block mixes numbers and booleans. */
export interface FlagRow {
  key: string;
  value: number | boolean | string;
  source: string;
}

interface NormsYaml {
  norms?: Record<string, { low?: number; high?: number } | null>;
  flags?: Record<string, number | boolean | string> | null;
}

export const DEFAULT_NORMS_URL =
  "https://raw.githubusercontent.com/bodhisattyabhattacharya-maker/swing-tracker/main/config/norms.yml";

/**
 * Pure: yml text -> rows.
 *
 * Validation here duplicates the CHECK constraints on the table, on purpose. The constraint is the
 * backstop that guarantees the invariant; this is the one that produces a message naming the
 * offending parameter, in the run log, where whoever edited the yml will actually look.
 *
 * What is deliberately NOT validated: whether a norm's key matches a parameter that exists. Twelve
 * of sixteen currently do not, because the parameters are not built yet, so "unknown key" cannot
 * be an error. A typo is therefore indistinguishable from a not-yet-built parameter here - which
 * is why scripts/verify_parameters.sql counts orphan norms instead, where the number changing is
 * the signal.
 */
export function parseNorms(
  text: string,
  source = "config/norms.yml",
): { norms: NormRow[]; flags: FlagRow[] } {
  const doc = parse(text) as NormsYaml;

  const norms: NormRow[] = [];
  for (const [param, bounds] of Object.entries(doc.norms ?? {})) {
    if (bounds == null) continue; // a commented-out norm parses as null, not as an error
    const low = bounds.low ?? null;
    const high = bounds.high ?? null;
    if (low === null && high === null) {
      throw new Error(`norms: "${param}" has neither low nor high - it would colour nothing`);
    }
    if (low !== null && high !== null && low >= high) {
      throw new Error(`norms: "${param}" has low ${low} >= high ${high} - the band is empty`);
    }
    if (low !== null && !Number.isFinite(low)) throw new Error(`norms: "${param}" low is not a number`);
    if (high !== null && !Number.isFinite(high)) throw new Error(`norms: "${param}" high is not a number`);
    norms.push({ param, low, high, source });
  }

  // See THE GUARD in the file header. This is the line that stops a bad fetch blanking the grid.
  if (norms.length === 0) {
    throw new Error("norms: parsed zero norms - refusing to sync, this would wipe every verdict");
  }

  const flags: FlagRow[] = [];
  for (const [key, value] of Object.entries(doc.flags ?? {})) {
    if (value == null) continue;
    flags.push({ key, value, source });
  }

  return { norms, flags };
}

export async function fetchNorms(
  url = DEFAULT_NORMS_URL,
): Promise<{ norms: NormRow[]; flags: FlagRow[] }> {
  const r = await fetch(url, { headers: { Accept: "text/plain" } });
  if (!r.ok) throw new Error(`norms: HTTP ${r.status} from ${url}`);
  return parseNorms(await r.text());
}
