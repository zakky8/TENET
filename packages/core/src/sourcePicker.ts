import type { Citation, Source } from './types.js';

/**
 * Strategy for selecting which retrieved source backs a verified claim.
 *
 * The default implementation (in @tenet/verifier) is intentionally simple
 * — case-insensitive substring + significant-token overlap. Apps that need
 * stronger guarantees (embedding similarity, RAGAS-style attribution,
 * citation graphs) plug in their own.
 */
export interface SourcePicker {
  pick(claim: string, sources: ReadonlyArray<Source>): Citation | null;
}

/** Token-set helper used by the default picker. Exported for reuse. */
export function significantTokens(s: string, minLen = 4): Set<string> {
  const out = new Set<string>();
  for (const t of s.toLowerCase().split(/\W+/)) {
    if (t.length >= minLen) out.add(t);
  }
  return out;
}
